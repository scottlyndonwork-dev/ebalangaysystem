import * as Sentry from '@sentry/node';
import { API_VERSION, buildApp } from './app.js';
import { createDb } from './db.js';
import { loadEnv } from './env.js';
import { createRedis } from './redis.js';

const env = loadEnv();

if (env.SENTRY_DSN) {
  Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV, release: API_VERSION });
}

const db = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const app = await buildApp({ env, db, redis });
redis.on('error', (err) => app.log.error({ err }, 'redis error'));
await redis.connect().catch((err: unknown) => app.log.error({ err }, 'redis connect failed'));

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await Promise.allSettled([db.$disconnect(), redis.quit()]);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.HOST, port: env.PORT });
