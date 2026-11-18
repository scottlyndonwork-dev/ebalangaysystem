import fp from 'fastify-plugin';
import type { Db } from '../db.js';
import type { Env } from '../env.js';
import type { SmsSender } from '../lib/sms.js';
import type { Storage } from '../lib/storage.js';
import type { RedisClient } from '../redis.js';

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    db: Db;
    redis: RedisClient;
    sms: SmsSender;
    storage: Storage;
  }
}

/** Shared dependencies, available as app.db / app.redis / app.env / app.sms / app.storage in every module. */
export const infraPlugin = fp<{
  env: Env;
  db: Db;
  redis: RedisClient;
  sms: SmsSender;
  storage: Storage;
}>(
  async (app, { env, db, redis, sms, storage }) => {
    app.decorate('env', env);
    app.decorate('db', db);
    app.decorate('redis', redis);
    app.decorate('sms', sms);
    app.decorate('storage', storage);
  },
  { name: 'infra' },
);
