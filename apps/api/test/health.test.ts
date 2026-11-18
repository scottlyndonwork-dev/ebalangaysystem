import { apiErrorSchema, healthResponseSchema } from '@ebalangay/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import type { RedisClient } from '../src/redis.js';
import { buildTestApp } from './helpers.js';

describe('GET /v1/health (real test database)', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  beforeAll(async () => {
    ctx = await buildTestApp({ env: { MIN_APP_VERSION: '1.2.0' } });
  });
  afterAll(() => ctx.close());

  it('returns ok with database check and a request id', async () => {
    const res = await request(ctx.app.server).get('/v1/health').expect(200);
    const body = healthResponseSchema.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ database: 'ok', redis: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('echoes a valid incoming request id', async () => {
    const res = await request(ctx.app.server)
      .get('/v1/health')
      .set('x-request-id', 'test-req-12345');
    expect(res.headers['x-request-id']).toBe('test-req-12345');
  });

  it('forces update when X-App-Version is below the minimum', async () => {
    const res = await request(ctx.app.server)
      .get('/v1/health')
      .set('x-app-version', '1.1.9')
      .expect(426);
    const body = apiErrorSchema.parse(res.body);
    expect(body.error.code).toBe('UPGRADE_REQUIRED');
    expect(body.error.details).toEqual({ minVersion: '1.2.0' });
  });

  it('accepts current app versions and rejects malformed ones', async () => {
    await request(ctx.app.server).get('/v1/health').set('x-app-version', '1.2.0').expect(200);
    const res = await request(ctx.app.server)
      .get('/v1/health')
      .set('x-app-version', 'banana')
      .expect(400);
    expect(apiErrorSchema.parse(res.body).error.code).toBe('VALIDATION_FAILED');
  });

  it('returns the shared error shape for unknown routes', async () => {
    const res = await request(ctx.app.server).get('/v1/nope').expect(404);
    expect(apiErrorSchema.parse(res.body).error.code).toBe('NOT_FOUND');
  });
});

describe('GET /v1/health (dependencies down)', () => {
  const down = () => Promise.reject(new Error('connection refused'));
  const up = () => Promise.resolve('ok');

  it.each([
    [
      'database',
      { db: { $queryRaw: down }, redis: { ping: up } },
      { database: 'down', redis: 'ok' },
    ],
    ['redis', { db: { $queryRaw: up }, redis: { ping: down } }, { database: 'ok', redis: 'down' }],
  ])('returns 503 degraded when %s is down', async (_name, stubs, checks) => {
    const ctx = await buildTestApp({
      db: stubs.db as unknown as Db,
      redis: stubs.redis as unknown as RedisClient,
    });
    try {
      const res = await request(ctx.app.server).get('/v1/health').expect(503);
      expect(healthResponseSchema.parse(res.body)).toMatchObject({ status: 'degraded', checks });
    } finally {
      await ctx.close();
    }
  });
});
