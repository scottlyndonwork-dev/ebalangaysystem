import { type ConnectionOptions, UnrecoverableError, Worker } from 'bullmq';
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import type { PushSender } from '../lib/push.js';
import type { SmsSender } from '../lib/sms.js';
import { pushJobSchema } from '../modules/notifications/payload.js';
import {
  checkReceipts,
  deliverPush,
  RECEIPTS_JOB,
  type ReceiptsJob,
} from '../modules/notifications/service.js';
import { flushBreadcrumbs } from '../modules/tracking/breadcrumbs.js';
import type { RedisClient } from '../redis.js';
import type { SocketEmitter } from './emitter.js';
import { relayOutbox } from './outbox-relay.js';
import { attachDeadLetter, QueueName, type Queues } from './queues.js';

export const OUTBOX_SCHEDULER_ID = 'outbox-relay-tick';
export const BREADCRUMB_SCHEDULER_ID = 'rider-breadcrumbs-flush';
export const BREADCRUMB_FLUSH_MS = 60_000;

export interface WorkerDeps {
  db: Db;
  /** Plain Redis client (rider locations, breadcrumb queue). */
  redis: RedisClient;
  queues: Queues;
  emitter: SocketEmitter;
  connection: ConnectionOptions;
  push: PushSender;
  /** Critical-alert SMS (rider nearby, delivered, COD reminder). */
  sms: SmsSender;
  log: Logger;
  outboxPollMs: number;
  breadcrumbFlushMs?: number;
  /** Must match the queues' prefix (tests isolate keys with one). */
  prefix?: string;
}

export interface WorkerRuntime {
  workers: Worker[];
  /** Waits for active jobs to finish; unfinished ones stay in Redis for the next start. */
  close(): Promise<void>;
}

export async function startWorkers(deps: WorkerDeps): Promise<WorkerRuntime> {
  const { db, queues, emitter, connection, log, prefix } = deps;
  const base = { connection, ...(prefix ? { prefix } : {}) };

  const outbox = new Worker(
    QueueName.OUTBOX,
    async () => {
      const r = await relayOutbox({
        db,
        emitter,
        notifications: queues.notifications,
        deadLetter: queues.deadLetter,
        log,
      });
      if (r.relayed || r.failed || r.deadLettered) log.debug(r, 'outbox relayed');
      return r;
    },
    // One tick at a time per process; the advisory lock covers other replicas.
    { ...base, concurrency: 1 },
  );
  outbox.on('failed', (_job, err) => log.warn({ err }, 'outbox tick failed'));

  const breadcrumbs = new Worker(
    QueueName.BREADCRUMBS,
    async () => {
      const r = await flushBreadcrumbs(db, deps.redis);
      if (r.breadcrumbs || r.riders) log.debug(r, 'breadcrumbs flushed');
      return r;
    },
    { ...base, concurrency: 1 },
  );

  const notifications = new Worker(
    QueueName.NOTIFICATIONS,
    async (job) => {
      if (job.name === RECEIPTS_JOB) {
        return checkReceipts({ db, push: deps.push }, job.data as ReceiptsJob);
      }
      const data = pushJobSchema.safeParse(job.data);
      // Retrying can't fix bad data: straight to the dead-letter queue.
      if (!data.success) throw new UnrecoverableError(`invalid push job: ${data.error.message}`);
      return deliverPush(
        { db, redis: deps.redis, push: deps.push, sms: deps.sms, queue: queues.notifications, log },
        data.data,
      );
    },
    { ...base, concurrency: 10 },
  );

  const workers = [outbox, breadcrumbs, notifications];
  for (const w of workers)
    w.on('error', (err) => log.error({ err, queue: w.name }, 'worker error'));
  // Ticks of a schedule aren't dead-lettered: the next tick is the retry.
  const scheduled: string[] = [QueueName.OUTBOX, QueueName.BREADCRUMBS];
  for (const w of workers.filter((x) => !scheduled.includes(x.name))) {
    attachDeadLetter(w, queues.deadLetter, log);
  }

  // Idempotent: replicas and restarts update the same scheduler instead of adding more.
  await queues.outbox.upsertJobScheduler(
    OUTBOX_SCHEDULER_ID,
    { every: deps.outboxPollMs },
    { name: 'tick' },
  );
  await queues.breadcrumbs.upsertJobScheduler(
    BREADCRUMB_SCHEDULER_ID,
    { every: deps.breadcrumbFlushMs ?? BREADCRUMB_FLUSH_MS },
    { name: 'flush' },
  );

  return {
    workers,
    close: async () => {
      await Promise.allSettled(workers.map((w) => w.close()));
    },
  };
}
