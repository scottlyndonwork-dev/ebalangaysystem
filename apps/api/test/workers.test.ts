import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Rooms } from '@ebalangay/shared';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import { pino } from 'pino';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryPush } from '../src/lib/push.js';
import { MemorySms } from '../src/lib/sms.js';
import { createSocketEmitter, type SocketEmitter } from '../src/workers/emitter.js';
import {
  MAX_EVENT_ATTEMPTS,
  pushJobId,
  RELAY_LOCK_KEY,
  relayOutbox,
  relayOutboxOnce,
  type RelayDeps,
} from '../src/workers/outbox-relay.js';
import {
  attachDeadLetter,
  bullConnection,
  closeQueues,
  createQueues,
  type DeadLetter,
  type Queues,
} from '../src/workers/queues.js';
import { startWorkers, type WorkerRuntime } from '../src/workers/runtime.js';
import { bearer, fixtures, must } from './fixtures.js';
import { buildTestApp, testEnv } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
const ADMIN_IP = '10.8.8.8';
const log = pino({ level: 'silent' });
const redisUrl = testEnv().REDIS_URL;

let ctx: Ctx;
let queues: Queues;
let connection: ConnectionOptions;
const prefix = `test-${randomUUID()}`;
const fx = fixtures(() => ctx);

interface Emitted {
  rooms: string[];
  event: string;
  payload: Record<string, unknown>;
}
let emitted: Emitted[] = [];
let emitterReady = true;
const fakeEmitter: SocketEmitter = {
  emit: (rooms, event, payload) =>
    emitted.push({ rooms, event, payload: payload as Record<string, unknown> }),
  ready: () => emitterReady,
  close: async () => {},
};

const deps = (): RelayDeps => ({
  db: ctx.app.db,
  emitter: fakeEmitter,
  notifications: queues.notifications,
  deadLetter: queues.deadLetter,
  log,
});

async function outbox(opts: { rooms?: string[]; push?: unknown; version?: number } = {}) {
  const aggregateId = randomUUID();
  return ctx.app.db.outboxEvent.create({
    data: {
      event: 'order.updated',
      aggregateType: 'order',
      aggregateId,
      version: opts.version ?? 1,
      payload: { id: aggregateId, version: opts.version ?? 1, occurredAt: new Date(), data: {} },
      rooms: opts.rooms ?? [Rooms.order(aggregateId)],
      ...(opts.push === undefined ? {} : { push: opts.push as object }),
    },
  });
}

const until = async (check: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};

beforeAll(async () => {
  connection = bullConnection(redisUrl);
  queues = createQueues(connection, prefix);
  ctx = await buildTestApp({
    realtime: true,
    queues,
    env: { ADMIN_IP_ALLOWLIST: ADMIN_IP, TRUST_PROXY_HOPS: '1' },
  });
});

beforeEach(async () => {
  emitted = [];
  emitterReady = true;
  // Other test files leave unrelayed rows behind; start each case from an empty outbox.
  await ctx.app.db.outboxEvent.updateMany({
    where: { processedAt: null },
    data: { processedAt: new Date() },
  });
});

afterAll(async () => {
  for (const q of Object.values(queues)) await q.obliterate({ force: true }).catch(() => {});
  await closeQueues(queues);
  await ctx?.close();
});

describe('outbox relay', () => {
  it('emits in commit order with eventId, enqueues push once, marks processed', async () => {
    const userId = randomUUID();
    const push = { userIds: [userId], titleKey: 't', bodyKey: 'b', params: { n: 1 } };
    const first = await outbox({ push, version: 1 });
    const second = await outbox({ version: 2 });

    const r = await relayOutbox(deps());
    expect(r).toMatchObject({ locked: true, relayed: 2, failed: 0 });
    expect(emitted.map((e) => e.payload.eventId)).toEqual([first.id, second.id]);
    expect(emitted[0]?.rooms).toEqual(first.rooms);
    expect(emitted[0]?.payload).toMatchObject({ id: first.aggregateId, version: 1 });

    const job = must(await queues.notifications.getJob(pushJobId(first.id)));
    expect(job.data).toMatchObject({ ...push, eventId: first.id, event: 'order.updated' });
    expect(await queues.notifications.getJob(pushJobId(second.id))).toBeUndefined();

    const rows = await ctx.app.db.outboxEvent.findMany({
      where: { id: { in: [first.id, second.id] } },
    });
    expect(rows.every((x) => x.processedAt && x.attempts === 1 && !x.lastError)).toBe(true);

    // Nothing left; a replayed push enqueue (crash before commit) is deduped by job id.
    expect((await relayOutbox(deps())).relayed).toBe(0);
    await queues.notifications.add('push', {}, { jobId: pushJobId(first.id) });
    expect((await queues.notifications.getJob(pushJobId(first.id)))?.data).toMatchObject(push);
  });

  it('a failing event blocks later ones, then is dead-lettered after max attempts', async () => {
    const bad = await outbox({ push: { userIds: ['not-a-uuid'], titleKey: 't', bodyKey: 'b' } });
    const next = await outbox();

    const r1 = await relayOutbox(deps());
    expect(r1).toMatchObject({ relayed: 0, failed: 1 });
    let row = must(await ctx.app.db.outboxEvent.findUnique({ where: { id: bad.id } }));
    expect(row).toMatchObject({ attempts: 1, processedAt: null });
    expect(row.lastError).toBeTruthy();
    expect(emitted).toHaveLength(0);

    await ctx.app.db.outboxEvent.update({
      where: { id: bad.id },
      data: { attempts: MAX_EVENT_ATTEMPTS - 1 },
    });
    const r2 = await relayOutbox(deps());
    expect(r2).toMatchObject({ relayed: 1, deadLettered: 1 });
    expect(emitted.map((e) => e.payload.eventId)).toEqual([next.id]);
    row = must(await ctx.app.db.outboxEvent.findUnique({ where: { id: bad.id } }));
    expect(row.processedAt).not.toBeNull();
    const dead = must(await queues.deadLetter.getJob(`outbox-${bad.id}`));
    expect(dead.data as DeadLetter).toMatchObject({ queue: 'outbox_events', jobId: bad.id });
  });

  it('only one relay runs at a time (advisory lock)', async () => {
    const e = await outbox();
    await ctx.app.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RELAY_LOCK_KEY}::bigint)`;
      const r = await relayOutboxOnce(deps());
      expect(r.locked).toBe(false);
    });
    expect(emitted).toHaveLength(0);
    expect((await relayOutbox(deps())).relayed).toBe(1);
    expect(emitted[0]?.payload.eventId).toBe(e.id);
  });

  it('fails the tick without touching rows while Redis is unreachable', async () => {
    const e = await outbox();
    emitterReady = false;
    await expect(relayOutbox(deps())).rejects.toThrow(/not connected/);
    const row = must(await ctx.app.db.outboxEvent.findUnique({ where: { id: e.id } }));
    expect(row).toMatchObject({ attempts: 0, processedAt: null });
  });
});

describe('worker process', () => {
  let runtime: WorkerRuntime;
  let emitter: SocketEmitter;
  let socket: Socket | undefined;

  beforeAll(async () => {
    emitter = createSocketEmitter(redisUrl);
    await until(async () => emitter.ready());
    runtime = await startWorkers({
      db: ctx.app.db,
      redis: ctx.app.redis,
      queues,
      emitter,
      connection,
      push: new MemoryPush(),
      sms: new MemorySms(),
      log,
      outboxPollMs: 100,
      prefix,
    });
  });

  afterAll(async () => {
    socket?.disconnect();
    await runtime?.close();
    await emitter?.close();
  });

  it('relays a committed outbox row to a socket on the API within a second', async () => {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    const customer = await fx.customer();
    const s = connect(url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token: customer.token },
    });
    socket = s;
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
    const received = new Promise<Record<string, unknown>>((resolve) =>
      s.once('order.updated', (p: Record<string, unknown>) => resolve(p)),
    );

    const started = Date.now();
    const e = await outbox({ rooms: [Rooms.user(customer.userId)] });
    const payload = await received;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(payload).toMatchObject({ eventId: e.id, id: e.aggregateId, version: 1 });
    await until(async () => {
      const row = await ctx.app.db.outboxEvent.findUnique({ where: { id: e.id } });
      return !!row?.processedAt;
    });
  });

  it('upserting the scheduler again (restart/replica) keeps a single schedule', async () => {
    const again = await startWorkers({
      db: ctx.app.db,
      redis: ctx.app.redis,
      queues,
      emitter,
      connection,
      push: new MemoryPush(),
      sms: new MemorySms(),
      log,
      outboxPollMs: 100,
      prefix,
    });
    await again.close();
    expect(await queues.outbox.getJobSchedulersCount()).toBe(1);
  });
});

describe('dead-letter queue', () => {
  it('copies a job there once its last retry fails', async () => {
    const name = `flaky-${randomUUID()}`;
    const q = new Queue(name, { connection, prefix });
    const w = new Worker(
      name,
      async (): Promise<void> => {
        throw new Error('boom');
      },
      { connection, prefix },
    );
    attachDeadLetter(w, queues.deadLetter, log);
    let calls = 0;
    w.on('failed', () => calls++);
    const job = await q.add('x', { a: 1 }, { attempts: 2, backoff: { type: 'fixed', delay: 10 } });

    await until(async () => !!(await queues.deadLetter.getJob(`${name}-${job.id}`)));
    expect(calls).toBe(2);
    const dead = must(await queues.deadLetter.getJob(`${name}-${job.id}`));
    expect(dead.data as DeadLetter).toMatchObject({
      queue: name,
      jobId: job.id,
      data: { a: 1 },
      failedReason: 'boom',
      attemptsMade: 2,
    });
    await w.close();
    await q.obliterate({ force: true });
    await q.close();
  });
});

describe('bull board', () => {
  const board = '/v1/admin/queues';

  it('is admin-only', async () => {
    const api = () => request(ctx.app.server);
    await api().get(board).set('x-forwarded-for', ADMIN_IP).expect(401);
    const customer = await fx.customer();
    await api().get(board).set('x-forwarded-for', ADMIN_IP).set(bearer(customer.token)).expect(403);

    const admin = await fx.user(['admin']);
    const token = fx.tokenFor(admin.id, ['admin'], 'admin-web');
    await api().get(board).set('x-forwarded-for', '100.2.3.4').set(bearer(token)).expect(403);
    const page = await api().get(board).set('x-forwarded-for', ADMIN_IP).set(bearer(token));
    expect(page.status).toBe(200);
    expect(page.text).toContain('<html');

    const list = await api()
      .get(`${board}/api/queues`)
      .set('x-forwarded-for', ADMIN_IP)
      .set(bearer(token))
      .expect(200);
    const names = (list.body as { queues: { name: string; readOnlyMode: boolean }[] }).queues;
    expect(names.map((q) => q.name).sort()).toEqual(
      [
        'dead-letter',
        'notifications',
        'outbox-relay',
        'rider-breadcrumbs',
        'scheduled-jobs',
      ].sort(),
    );
    expect(names.every((q) => q.readOnlyMode)).toBe(true);
  });
});
