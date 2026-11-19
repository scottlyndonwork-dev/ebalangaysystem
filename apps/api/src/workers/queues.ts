import { type ConnectionOptions, type Job, type JobsOptions, Queue, type Worker } from 'bullmq';
import type { Logger } from 'pino';

export const QueueName = {
  OUTBOX: 'outbox-relay',
  NOTIFICATIONS: 'notifications',
  /** Batch-writes queued rider breadcrumbs to Postgres every 60s. */
  BREADCRUMBS: 'rider-breadcrumbs',
  /** Jobs that failed every attempt land here for inspection (Bull Board). No consumer. */
  DEAD_LETTER: 'dead-letter',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

/** Retry with exponential backoff (1s, 2s, 4s, ...); failures kept a week for inspection. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/**
 * BullMQ connection options from a redis:// URL. BullMQ opens its own connections (blocking
 * commands need `maxRetriesPerRequest: null`), so the API's shared ioredis client isn't reused.
 */
export function bullConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    db: Number(u.pathname.slice(1) || 0),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

export interface Queues {
  outbox: Queue;
  notifications: Queue;
  breadcrumbs: Queue;
  deadLetter: Queue;
}

/** `prefix` isolates keys (tests); production uses BullMQ's default `bull`. */
export function createQueues(connection: ConnectionOptions, prefix?: string): Queues {
  const make = (name: QueueName, defaultJobOptions: JobsOptions = DEFAULT_JOB_OPTIONS) =>
    new Queue(name, { connection, defaultJobOptions, ...(prefix ? { prefix } : {}) });
  return {
    // Relay ticks are retried by the next tick; per-event failures are tracked on the row.
    outbox: make(QueueName.OUTBOX, { attempts: 1, removeOnComplete: true, removeOnFail: 100 }),
    notifications: make(QueueName.NOTIFICATIONS),
    // Periodic: a failed run is simply retried by the next one, so no backoff or DLQ.
    breadcrumbs: make(QueueName.BREADCRUMBS, {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: 100,
    }),
    deadLetter: make(QueueName.DEAD_LETTER, { removeOnComplete: { age: 30 * 24 * 3600 } }),
  };
}

export const allQueues = (q: Queues): Queue[] => [
  q.outbox,
  q.notifications,
  q.breadcrumbs,
  q.deadLetter,
];

export async function closeQueues(q: Queues): Promise<void> {
  await Promise.allSettled(allQueues(q).map((x) => x.close()));
}

export interface DeadLetter {
  queue: string;
  jobId: string | null;
  name: string;
  data: unknown;
  failedReason: string;
  attemptsMade: number;
  failedAt: string;
}

/** True once BullMQ won't retry the job again. */
export function isFinalFailure(job: Job, err: Error): boolean {
  return err.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
}

/** Copies a job to the dead-letter queue after its last attempt fails. */
export function attachDeadLetter(worker: Worker, deadLetter: Queue, log: Logger): void {
  worker.on('failed', (job, err) => {
    if (!job || !isFinalFailure(job, err)) return;
    const entry: DeadLetter = {
      queue: worker.name,
      jobId: job.id ?? null,
      name: job.name,
      data: job.data as unknown,
      failedReason: err.message.slice(0, 1000),
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
    };
    log.error({ queue: worker.name, jobId: job.id, err }, 'job dead-lettered');
    // Deterministic id: a duplicate 'failed' event can't dead-letter the same job twice.
    const opts = job.id ? { jobId: `${worker.name}-${job.id}` } : {};
    deadLetter.add(job.name, entry, opts).catch((e: unknown) => {
      log.error({ err: e, queue: worker.name, jobId: job.id }, 'dead-letter enqueue failed');
    });
  });
}
