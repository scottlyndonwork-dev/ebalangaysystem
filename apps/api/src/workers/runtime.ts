import { type ConnectionOptions, UnrecoverableError, Worker } from 'bullmq';
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import type { PushSender } from '../lib/push.js';
import type { SmsSender } from '../lib/sms.js';
import type { Storage } from '../lib/storage.js';
import { refreshAnalyticsViews } from '../modules/analytics/refresh.js';
import { menuBoundaryTick } from '../modules/catalog/menu-cache.js';
import { evaluateVerifiedBadges } from '../modules/merchants/verified-badge.js';
import { pushJobSchema } from '../modules/notifications/payload.js';
import {
  checkReceipts,
  deliverPush,
  RECEIPTS_JOB,
  type ReceiptsJob,
} from '../modules/notifications/service.js';
import { releaseScheduledOrders } from '../modules/orders/release.js';
import { sweepStaleOrders } from '../modules/orders/sweeper.js';
import { expirePoints } from '../modules/points/expiry.js';
import { expireStories } from '../modules/stories/expiry.js';
import { runSubscriptions } from '../modules/subscriptions/run.js';
import { flushBreadcrumbs } from '../modules/tracking/breadcrumbs.js';
import type { RedisClient } from '../redis.js';
import type { SocketEmitter } from './emitter.js';
import { relayOutbox } from './outbox-relay.js';
import { attachDeadLetter, QueueName, type Queues } from './queues.js';

export const OUTBOX_SCHEDULER_ID = 'outbox-relay-tick';
export const BREADCRUMB_SCHEDULER_ID = 'rider-breadcrumbs-flush';
export const BREADCRUMB_FLUSH_MS = 60_000;

/** Jobs on the `scheduled-jobs` queue; the job name picks the handler. */
export const ScheduledJob = {
  RELEASE_SCHEDULED_ORDERS: 'release-scheduled-orders',
  SWEEP_STALE_ORDERS: 'sweep-stale-orders',
  RUN_SUBSCRIPTIONS: 'run-subscriptions',
  EXPIRE_STORIES: 'expire-stories',
  MENU_BOUNDARIES: 'menu-boundaries',
  EXPIRE_POINTS: 'expire-points',
  REFRESH_ANALYTICS: 'refresh-analytics',
  VERIFIED_BADGES: 'verified-badges',
} as const;
export type ScheduledJob = (typeof ScheduledJob)[keyof typeof ScheduledJob];

/** Interval jobs: a failed tick is retried by the next one. */
export const SCHEDULED_EVERY_MS: Partial<Record<ScheduledJob, number>> = {
  [ScheduledJob.RELEASE_SCHEDULED_ORDERS]: 60_000,
  [ScheduledJob.SWEEP_STALE_ORDERS]: 60_000,
  [ScheduledJob.RUN_SUBSCRIPTIONS]: 5 * 60_000,
  [ScheduledJob.EXPIRE_STORIES]: 5 * 60_000,
};

export const SCHEDULE_TZ = 'Asia/Manila';

/** Cron jobs (Manila wall clock). `retry` jobs back off and are dead-lettered after the last try. */
export const SCHEDULED_CRON: Partial<Record<ScheduledJob, { pattern: string; retry: boolean }>> = {
  // On the minute, so menu windows flip close to their HH:mm.
  [ScheduledJob.MENU_BOUNDARIES]: { pattern: '* * * * *', retry: false },
  [ScheduledJob.REFRESH_ANALYTICS]: { pattern: '0 0 * * *', retry: true },
  [ScheduledJob.EXPIRE_POINTS]: { pattern: '15 0 * * *', retry: true },
  [ScheduledJob.VERIFIED_BADGES]: { pattern: '0 3 * * 1', retry: true },
};

/** Daily/weekly jobs: 5 tries over ~30 min (1, 2, 4, 8, 16 min). */
export const CRON_RETRY = { attempts: 5, backoff: { type: 'exponential', delay: 60_000 } } as const;

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
  /** Story media cleanup. */
  storage: Storage;
  log: Logger;
  outboxPollMs: number;
  breadcrumbFlushMs?: number;
  /** Override tick intervals (tests). */
  scheduledEveryMs?: Partial<Record<ScheduledJob, number>>;
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

  const scheduledJobs = new Worker(
    QueueName.SCHEDULED,
    async (job) => {
      switch (job.name as ScheduledJob) {
        case ScheduledJob.RELEASE_SCHEDULED_ORDERS:
          return releaseScheduledOrders(db);
        case ScheduledJob.SWEEP_STALE_ORDERS:
          return sweepStaleOrders({ db, redis: deps.redis, log });
        case ScheduledJob.RUN_SUBSCRIPTIONS:
          return runSubscriptions({ db, log });
        case ScheduledJob.EXPIRE_STORIES:
          return expireStories({ db, storage: deps.storage, log });
        case ScheduledJob.MENU_BOUNDARIES:
          return menuBoundaryTick({ db, redis: deps.redis, log });
        case ScheduledJob.EXPIRE_POINTS:
          return expirePoints(db);
        case ScheduledJob.REFRESH_ANALYTICS:
          return refreshAnalyticsViews(db);
        case ScheduledJob.VERIFIED_BADGES:
          return evaluateVerifiedBadges({ db, log });
        default:
          throw new UnrecoverableError(`unknown scheduled job ${job.name}`);
      }
    },
    // One at a time: a long run of one job must not overlap its own next tick.
    { ...base, concurrency: 1 },
  );

  const workers = [outbox, breadcrumbs, notifications, scheduledJobs];
  for (const w of workers)
    w.on('error', (err) => log.error({ err, queue: w.name }, 'worker error'));
  // Ticks of a schedule aren't dead-lettered: the next tick is the retry.
  const ticks: string[] = [QueueName.OUTBOX, QueueName.BREADCRUMBS];
  for (const w of workers.filter((x) => !ticks.includes(x.name))) {
    attachDeadLetter(
      w,
      queues.deadLetter,
      log,
      // scheduled-jobs: only jobs that opted into retries (single-shot ticks just run again).
      w.name === QueueName.SCHEDULED ? (job) => (job.opts.attempts ?? 1) > 1 : undefined,
    );
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

  for (const [name, every] of Object.entries(SCHEDULED_EVERY_MS)) {
    await queues.scheduled.upsertJobScheduler(
      name,
      { every: deps.scheduledEveryMs?.[name as ScheduledJob] ?? every },
      { name },
    );
  }
  for (const [name, cron] of Object.entries(SCHEDULED_CRON)) {
    const every = deps.scheduledEveryMs?.[name as ScheduledJob];
    await queues.scheduled.upsertJobScheduler(
      name,
      every ? { every } : { pattern: cron.pattern, tz: SCHEDULE_TZ },
      { name, ...(cron.retry ? { opts: CRON_RETRY } : {}) },
    );
  }

  return {
    workers,
    close: async () => {
      await Promise.allSettled(workers.map((w) => w.close()));
    },
  };
}
