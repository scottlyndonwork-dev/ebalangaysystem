import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db.js';
import { type Env, loadEnv } from '../src/env.js';
import { createRedis, type RedisClient } from '../src/redis.js';

export function testEnv(overrides: Partial<Record<keyof Env, string>> = {}): Env {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see apps/api/.env.example)');
  return loadEnv({
    ...process.env,
    DATABASE_URL: url,
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

export async function buildTestApp(
  opts: { db?: Db; redis?: RedisClient; env?: Partial<Record<keyof Env, string>> } = {},
): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const env = testEnv(opts.env);
  const db = opts.db ?? createDb(env.DATABASE_URL);
  const redis = opts.redis ?? createRedis(env.REDIS_URL);
  if (!opts.redis) await redis.connect();
  const app = await buildApp({ env, db, redis });
  await app.ready();
  return {
    app,
    close: async () => {
      await app.close();
      if (!opts.db) await db.$disconnect();
      if (!opts.redis) await redis.quit();
    },
  };
}
