import { type ConnectionOptions, Worker } from 'bullmq';
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import type { SocketEmitter } from './emitter.js';
import { relayOutbox } from './outbox-relay.js';
import { attachDeadLetter, QueueName, type Queues } from './queues.js';

export const OUTBOX_SCHEDULER_ID = 'outbox-relay-tick';

export interface WorkerDeps {
  db: Db;
  queues: Queues;
  emitter: SocketEmitter;
  connection: ConnectionOptions;
  log: Logger;
  outboxPollMs: number;
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

  const workers = [outbox];
  for (const w of workers)
    w.on('error', (err) => log.error({ err, queue: w.name }, 'worker error'));
  for (const w of workers.filter((x) => x.name !== QueueName.OUTBOX)) {
    attachDeadLetter(w, queues.deadLetter, log);
  }

  // Idempotent: replicas and restarts update the same scheduler instead of adding more.
  await queues.outbox.upsertJobScheduler(
    OUTBOX_SCHEDULER_ID,
    { every: deps.outboxPollMs },
    { name: 'tick' },
  );

  return {
    workers,
    close: async () => {
      await Promise.allSettled(workers.map((w) => w.close()));
    },
  };
}
