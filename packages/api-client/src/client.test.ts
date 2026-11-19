import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, buildUrl, createApiClient, type ApiClientOptions } from './client.js';
import { ApiClientError } from './errors.js';
import { keysForRoom, queryKeys } from './query-keys.js';
import { keysForEvent, parseSocketPayload, VersionTracker } from './socket.js';

const id = '7d9f6a2e-1c3b-4f5a-9e8d-2b1c0a9f8e7d';
const health = {
  status: 'ok',
  version: '0.1.0',
  time: '2026-11-18T03:00:00.000Z',
  checks: { database: 'ok', redis: 'ok' },
};
const user = {
  id,
  phone: '+639171234567',
  email: null,
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  avatarUrl: null,
  roles: ['customer'],
  locale: 'ceb',
  createdAt: '2026-11-18T03:00:00.000Z',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, details?: unknown) =>
  json(status, { error: { code, message: code, details } });

function setup(responses: (Response | Error)[], overrides: Partial<ApiClientOptions> = {}) {
  const queue = [...responses];
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => {});
  let token = 'old-token';
  const refreshToken = vi.fn(async () => {
    await Promise.resolve();
    token = 'new-token';
    return token;
  });
  const client = createApiClient({
    baseUrl: 'https://api.test/',
    getToken: () => token,
    refreshToken,
    appVersion: '1.4.0',
    platform: 'customer',
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep,
    ...overrides,
  });
  const headersOf = (call: number) =>
    (fetch.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
  return { client, fetch, sleep, refreshToken, headersOf };
}

describe('createApiClient', () => {
  it('sends version, platform and auth headers and validates the response', async () => {
    const { client, fetch, headersOf } = setup([json(200, user)]);
    await expect(client.auth.me()).resolves.toEqual(user);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.test/v1/me');
    expect(headersOf(0)).toMatchObject({
      'x-app-version': '1.4.0',
      'x-app-platform': 'customer',
      authorization: 'Bearer old-token',
    });
  });

  it('does not attach a token to public endpoints', async () => {
    const { client, headersOf } = setup([json(200, health)]);
    await client.health.get();
    expect(headersOf(0).authorization).toBeUndefined();
  });

  it('refreshes once on 401 and replays the request with the new token', async () => {
    const { client, refreshToken, headersOf } = setup([
      apiError(401, 'TOKEN_EXPIRED'),
      json(200, user),
    ]);
    await expect(client.auth.me()).resolves.toMatchObject({ id });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(headersOf(1).authorization).toBe('Bearer new-token');
  });

  it('queues concurrent 401s behind a single refresh', async () => {
    const { client, refreshToken } = setup([
      apiError(401, 'TOKEN_EXPIRED'),
      apiError(401, 'TOKEN_EXPIRED'),
      apiError(401, 'TOKEN_EXPIRED'),
      json(200, user),
      json(200, user),
      json(200, user),
    ]);
    await Promise.all([client.auth.me(), client.auth.me(), client.auth.me()]);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('reports an expired session when refresh fails', async () => {
    const onSessionExpired = vi.fn();
    const { client } = setup([apiError(401, 'UNAUTHENTICATED')], {
      refreshToken: async () => null,
      onSessionExpired,
    });
    await expect(client.auth.me()).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    expect(onSessionExpired).toHaveBeenCalledOnce();
  });

  it('retries network errors with backoff for idempotent requests', async () => {
    const { client, fetch, sleep } = setup([
      new TypeError('fetch failed'),
      new TypeError('x'),
      json(200, health),
    ]);
    await expect(client.health.get()).resolves.toMatchObject({ status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry budget with a NETWORK error', async () => {
    const { client, fetch } = setup([new TypeError('a'), new TypeError('b'), new TypeError('c')]);
    const err = await client.health.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ code: 'NETWORK', i18nKey: 'errors:NETWORK' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('never retries a POST without an idempotency key', async () => {
    const { client, fetch } = setup([new TypeError('fetch failed')]);
    await expect(client.auth.requestOtp({ phone: '+639171234567' })).rejects.toMatchObject({
      code: 'NETWORK',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a POST with an idempotency key and sends the header', async () => {
    const { client, fetch, headersOf } = setup([json(503, {}), json(201, { ok: true })]);
    await client.request('POST', '/v1/payments', { body: {}, idempotencyKey: 'key-1' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(headersOf(1)['idempotency-key']).toBe('key-1');
  });

  it('signals force-update on 426', async () => {
    const onForceUpdate = vi.fn();
    const { client } = setup([apiError(426, 'UPGRADE_REQUIRED', { minVersion: '2.0.0' })], {
      onForceUpdate,
    });
    await expect(client.health.get()).rejects.toMatchObject({ code: 'UPGRADE_REQUIRED' });
    expect(onForceUpdate).toHaveBeenCalledWith({ minVersion: '2.0.0' });
  });

  it('maps non-JSON errors by status and rejects unexpected shapes', async () => {
    const { client } = setup([new Response('<html>', { status: 502 }), json(200, { nope: 1 })], {
      retry: { retries: 0 },
    });
    await expect(client.health.get()).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 502,
    });
    await expect(client.health.get()).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('helpers', () => {
  it('builds URLs with repeated array params and skips empty values', () => {
    expect(
      buildUrl('https://a/', '/v1/orders', {
        status: ['placed', 'ready'],
        cursor: undefined,
        limit: 20,
      }),
    ).toBe('https://a/v1/orders?status=placed&status=ready&limit=20');
  });

  it('caps backoff and applies jitter', () => {
    const opts = { retries: 5, baseDelayMs: 500, maxDelayMs: 8000 };
    expect(backoffDelay(0, opts, () => 1)).toBe(500);
    expect(backoffDelay(2, opts, () => 0)).toBe(1000);
    expect(backoffDelay(10, opts, () => 1)).toBe(8000);
  });
});

describe('socket helpers', () => {
  const payload = {
    eventId: id,
    id,
    version: 2,
    occurredAt: '2026-11-18T03:00:00.000Z',
    data: { status: 'preparing', previousStatus: 'confirmed', actor: 'merchant', etaAt: null },
  } as const;

  it('validates payloads and maps events to stale queries', () => {
    const parsed = parseSocketPayload('order.updated', payload);
    expect(parsed).not.toBeNull();
    expect(parseSocketPayload('order.updated', { id })).toBeNull();
    expect(keysForEvent('order.updated', payload)).toEqual([
      queryKeys.orders.detail(id),
      queryKeys.orders.lists(),
    ]);
  });

  it('drops stale or duplicate versions', () => {
    const v = new VersionTracker();
    expect(v.accept('order.updated', { id, version: 2 })).toBe(true);
    expect(v.accept('order.updated', { id, version: 2 })).toBe(false);
    expect(v.accept('order.updated', { id, version: 1 })).toBe(false);
    expect(v.accept('order.updated', { id, version: 3 })).toBe(true);
  });

  it('knows what to refetch after rejoining a room', () => {
    expect(keysForRoom('order', id)).toEqual([queryKeys.orders.detail(id)]);
    expect(keysForRoom('admin', null)).toEqual([queryKeys.admin.all()]);
  });
});
