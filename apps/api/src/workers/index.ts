import * as Sentry from '@sentry/node';
import { pino } from 'pino';
import { assertExtensions, createDb } from '../db.js';
import { loadEnv } from '../env.js';
import { initSentry } from '../plugins/sentry.js';
import { createRedis } from '../redis.js';
import { createSocketEmitter } from './emitter.js';
import { bullConnection, closeQueues, createQueues } from './queues.js';
import { startWorkers } from './runtime.js';

/** Worker process entry (its own Railway service): `node dist/workers/index.js`. */
const env = loadEnv();
initSentry(env);

const log = pino({
  name: 'workers',
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});

const db = createDb(env.DATABASE_URL);
try {
  await assertExtensions(db);
} catch (err) {
  console.error(`\n[eBalangay workers] Startup aborted.\n${(err as Error).message}\n`);
  await db.$disconnect();
  process.exit(1);
}

const connection = bullConnection(env.REDIS_URL);
const queues = createQueues(connection);
const emitter = createSocketEmitter(env.REDIS_URL, (err) => log.error({ err }, 'redis error'));
const redis = createRedis(env.REDIS_URL);
redis.on('error', (err) => log.error({ err }, 'redis error'));
await redis.connect().catch((err: unknown) => log.error({ err }, 'redis connect failed'));
const runtime = await startWorkers({
  db,
  redis,
  queues,
  emitter,
  connection,
  log,
  outboxPollMs: env.OUTBOX_POLL_MS,
});
log.info({ queues: runtime.workers.map((w) => w.name) }, 'workers started');

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down workers');
  await runtime.close();
  await closeQueues(queues);
  await Promise.allSettled([emitter.close(), redis.quit(), db.$disconnect(), Sentry.close(2000)]);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
