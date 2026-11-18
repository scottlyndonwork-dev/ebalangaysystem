import { buildApp } from './app.js';
import { assertExtensions, createDb } from './db.js';
import { loadEnv } from './env.js';
import { initSentry } from './plugins/sentry.js';
import { attachRealtime } from './plugins/socket.js';
import { createRedis } from './redis.js';

const env = loadEnv();
initSentry(env);

const db = createDb(env.DATABASE_URL);
try {
  await assertExtensions(db);
} catch (err) {
  // Plain stderr: this must be readable even before the logger exists.
  console.error(`\n[eBalangay API] Startup aborted.\n${(err as Error).message}\n`);
  await db.$disconnect();
  process.exit(1);
}

const redis = createRedis(env.REDIS_URL);
const app = await buildApp({ env, db, redis });
attachRealtime(app);
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
