import { randomInt } from 'node:crypto';
import { verifyOtpResponseSchema } from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import type { Server as IoServer } from 'socket.io';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db.js';
import { type Env, type EnvInput, loadEnv } from '../src/env.js';
import { MemorySms } from '../src/lib/sms.js';
import { MemoryStorage } from '../src/lib/storage.js';
import { attachRealtime } from '../src/plugins/socket.js';
import { createRedis, type RedisClient } from '../src/redis.js';

/** Fixed, non-secret values so tests and CI need no real secrets. */
const TEST_SECRETS = {
  JWT_ACCESS_SECRET: 'test-jwt-secret-0123456789abcdef0123456789',
  OTP_PEPPER: 'test-otp-pepper-0123456789abcdef0123456789',
  COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef01234567',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

export function testEnv(overrides: EnvInput = {}): Env {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see apps/api/.env.example)');
  return loadEnv({
    ...TEST_SECRETS,
    ...process.env,
    NODE_ENV: 'test',
    SMS_DRIVER: 'console',
    DATABASE_URL: url,
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

export async function buildTestApp(
  opts: { db?: Db; redis?: RedisClient; env?: EnvInput; realtime?: boolean } = {},
): Promise<{
  app: FastifyInstance;
  /** Socket.IO server, only with `realtime: true`. */
  io: IoServer | null;
  sms: MemorySms;
  storage: MemoryStorage;
  close: () => Promise<void>;
}> {
  const env = testEnv(opts.env);
  const db = opts.db ?? createDb(env.DATABASE_URL);
  const redis = opts.redis ?? createRedis(env.REDIS_URL);
  if (!opts.redis) await redis.connect();
  const sms = new MemorySms();
  const storage = new MemoryStorage();
  const app = await buildApp({ env, db, redis, sms, storage });
  const io = opts.realtime ? attachRealtime(app) : null;
  await app.ready();
  return {
    app,
    io,
    sms,
    storage,
    close: async () => {
      await app.close();
      if (!opts.db) await db.$disconnect();
      if (!opts.redis) await redis.quit();
    },
  };
}

let seq = 0;
/** Unique +639 number per call, so tests never collide with each other or earlier runs. */
export function randomPhone(): string {
  seq = (seq + 1) % 1000;
  const n = randomInt(0, 1_000_000) * 1000 + seq;
  return `+639${String(n).padStart(9, '0')}`;
}

/** Unique client IP (sent as X-Forwarded-For) so per-IP limits don't leak between tests. */
export function randomIp(): string {
  const r = () => randomInt(1, 255);
  return `100.${r()}.${r()}.${r()}`;
}

type TestCtx = Awaited<ReturnType<typeof buildTestApp>>;

/** Makes earlier OTP requests for `phone` look `ms` older (skips cooldowns/windows). */
export async function ageOtps(ctx: TestCtx, phone: string, ms: number): Promise<void> {
  await ctx.app.db.$executeRaw`
    UPDATE otp_requests SET created_at = created_at - make_interval(secs => ${ms / 1000})
    WHERE phone = ${phone}`;
}

/** Full OTP flow through the API; returns tokens and user. */
export async function signInWithOtp(
  ctx: TestCtx,
  phone: string,
  platform = 'customer',
  deviceId?: string,
) {
  await ageOtps(ctx, phone, 60_000);
  await request(ctx.app.server)
    .post('/v1/auth/otp/request')
    .set('x-forwarded-for', randomIp())
    .send({ phone })
    .expect(200);
  const code = codeFor(ctx, phone);
  const res = await request(ctx.app.server)
    .post('/v1/auth/otp/verify')
    .set('x-forwarded-for', randomIp())
    .send({ phone, code, platform, deviceId })
    .expect(200);
  return verifyOtpResponseSchema.parse(res.body);
}

/** The last OTP texted to `phone` (MemorySms). */
export function codeFor(ctx: TestCtx, phone: string): string {
  const code = ctx.sms.lastCodeFor(phone);
  if (!code) throw new Error(`no OTP captured for ${phone}`);
  return code;
}
