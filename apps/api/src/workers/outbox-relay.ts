import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db } from '../db.js';
import type { DeadLetter } from './queues.js';
import type { SocketEmitter } from './emitter.js';

/** Rows per transaction; a full batch triggers another pass in the same tick. */
export const RELAY_BATCH_SIZE = 100;
/** Max passes per tick, so one tick can't hold the lock forever under a flood. */
const MAX_PASSES = 10;
/** A row that keeps failing is dead-lettered so it stops blocking later events. */
export const MAX_EVENT_ATTEMPTS = 10;
/** pg advisory lock key: one relay at a time across all worker replicas. */
export const RELAY_LOCK_KEY = 7_201_001;

const pushSchema = z.object({
  userIds: z.array(z.uuid()).min(1),
  titleKey: z.string().min(1),
  bodyKey: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

/** Job data on the notifications queue (processor lands in 2C-4). */
export type PushJob = z.infer<typeof pushSchema> & { eventId: string; event: string };

export const pushJobId = (eventId: string) => `push-${eventId}`;

export interface RelayDeps {
  db: Db;
  emitter: SocketEmitter;
  notifications: Queue;
  deadLetter: Queue;
  log: Logger;
}

export interface RelayResult {
  /** False when another relay held the lock. */
  locked: boolean;
  relayed: number;
  failed: number;
  deadLettered: number;
}

/**
 * One relay pass: unprocessed outbox rows in commit order → socket rooms + push jobs → mark
 * processed, all under a transaction-scoped advisory lock.
 *
 * Push jobs use the event id as job id, so BullMQ enqueues each at most once even if this
 * transaction rolls back after the enqueue. Socket emits can't be un-sent: a crash between
 * emit and commit re-emits on the next pass, so clients dedupe by `eventId` and drop
 * versions older than what they hold (rule 6: events are hints, REST is the truth).
 */
export async function relayOutboxOnce(
  deps: RelayDeps,
  batchSize = RELAY_BATCH_SIZE,
): Promise<RelayResult & { full: boolean }> {
  // An emit while Redis is down is silently lost; fail the tick instead (next tick retries).
  if (!deps.emitter.ready()) throw new Error('socket emitter not connected');

  return deps.db.$transaction(
    async (tx) => {
      const res = { locked: true, relayed: 0, failed: 0, deadLettered: 0, full: false };
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${RELAY_LOCK_KEY}::bigint) AS locked`;
      if (!lock?.locked) return { ...res, locked: false };

      const rows = await tx.outboxEvent.findMany({
        where: { processedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: batchSize,
      });
      res.full = rows.length === batchSize;

      for (const row of rows) {
        try {
          const push = row.push === null ? null : pushSchema.parse(row.push);
          if (push) {
            const job: PushJob = { ...push, eventId: row.id, event: row.event };
            await deps.notifications.add('push', job, { jobId: pushJobId(row.id) });
          }
          deps.emitter.emit(row.rooms, row.event, {
            ...(row.payload as Record<string, unknown>),
            eventId: row.id,
          });
          await tx.outboxEvent.update({
            where: { id: row.id },
            data: { processedAt: new Date(), attempts: { increment: 1 }, lastError: null },
          });
          res.relayed++;
        } catch (err) {
          const attempts = row.attempts + 1;
          const message = (err as Error).message.slice(0, 1000);
          const dead = attempts >= MAX_EVENT_ATTEMPTS;
          await tx.outboxEvent.update({
            where: { id: row.id },
            data: { attempts, lastError: message, ...(dead ? { processedAt: new Date() } : {}) },
          });
          if (dead) {
            const entry: DeadLetter = {
              queue: 'outbox_events',
              jobId: row.id,
              name: row.event,
              data: { aggregateType: row.aggregateType, aggregateId: row.aggregateId },
              failedReason: message,
              attemptsMade: attempts,
              failedAt: new Date().toISOString(),
            };
            await deps.deadLetter.add('outbox', entry, { jobId: `outbox-${row.id}` });
            deps.log.error({ eventId: row.id, err }, 'outbox event dead-lettered');
            res.deadLettered++;
            continue;
          }
          deps.log.warn({ eventId: row.id, attempts, err }, 'outbox event relay failed');
          res.failed++;
          // Keep commit order: later events wait until this one goes through or dies.
          res.full = false;
          break;
        }
      }
      return res;
    },
    { timeout: 30_000 },
  );
}

/** Drains the outbox (bounded): one call per scheduler tick. */
export async function relayOutbox(deps: RelayDeps): Promise<RelayResult> {
  const total: RelayResult = { locked: true, relayed: 0, failed: 0, deadLettered: 0 };
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const r = await relayOutboxOnce(deps);
    total.locked = r.locked;
    total.relayed += r.relayed;
    total.failed += r.failed;
    total.deadLettered += r.deadLettered;
    if (!r.locked || !r.full) break;
  }
  return total;
}
