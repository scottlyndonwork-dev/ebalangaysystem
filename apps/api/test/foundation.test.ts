import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertExtensions, type Db } from '../src/db.js';
import { loadEnv } from '../src/env.js';
import { buildTestApp, testEnv } from './helpers.js';

describe('foundation', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  beforeAll(async () => {
    ctx = await buildTestApp({ env: { CORS_ORIGINS: 'https://business.ebalangay.ph' } });
  });
  afterAll(() => ctx.close());

  it('/health is a dependency-free liveness probe', async () => {
    const res = await request(ctx.app.server).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', version: expect.any(String) });
  });

  it('/ready checks Postgres and Redis', async () => {
    const res = await request(ctx.app.server).get('/ready').expect(200);
    expect(res.body.checks).toEqual({ database: 'ok', redis: 'ok' });
  });

  it('serves OpenAPI generated from Zod schemas outside production', async () => {
    const res = await request(ctx.app.server).get('/docs/json').expect(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(
      res.body.paths['/ready'].get.responses['200'].content['application/json'].schema.properties
        .checks,
    ).toBeDefined();
  });

  it('allows only configured browser origins, with credentials', async () => {
    const ok = await request(ctx.app.server)
      .get('/health')
      .set('origin', 'https://business.ebalangay.ph');
    expect(ok.headers['access-control-allow-origin']).toBe('https://business.ebalangay.ph');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await request(ctx.app.server).get('/health').set('origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets security headers', async () => {
    const res = await request(ctx.app.server).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('confirms PostGIS and pg_trgm are installed', async () => {
    await expect(assertExtensions(ctx.app.db)).resolves.toBeUndefined();
  });

  it('explains how to fix missing extensions', async () => {
    const fake = { $queryRaw: async () => [{ extname: 'plpgsql' }] } as unknown as Db;
    await expect(assertExtensions(fake)).rejects.toThrow(/CREATE EXTENSION IF NOT EXISTS postgis;/);
  });
});

describe('config', () => {
  it('fails fast listing every missing secret without printing values', () => {
    expect(() => loadEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5433/x' })).toThrow(
      /JWT_ACCESS_SECRET[\s\S]*OTP_PEPPER[\s\S]*COOKIE_SECRET[\s\S]*DATA_ENCRYPTION_KEY/,
    );
  });

  it('enforces production guards', () => {
    expect(() => testEnv({ NODE_ENV: 'production' })).toThrow(
      /SMS_DRIVER[\s\S]*ADMIN_IP_ALLOWLIST/,
    );
  });

  it('turns docs off by default in production', () => {
    const env = testEnv({
      NODE_ENV: 'production',
      SMS_DRIVER: 'semaphore',
      SEMAPHORE_API_KEY: 'k',
      ADMIN_IP_ALLOWLIST: '10.0.0.0/8',
      CORS_ORIGINS: 'https://admin.ebalangay.ph',
    });
    expect(env.DOCS_ENABLED).toBe(false);
  });
});
