/**
 * Phase 2C acceptance: customer and merchant see an order change within 1 s through the real
 * outbox -> worker -> Socket.io path; a reconnecting client refetches the truth over REST;
 * workers restart without losing jobs.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  type Cart,
  type Order,
  type RoomAck,
  Rooms,
  SocketCommand,
  SocketEvent,
} from '@ebalangay/shared';
import type { ConnectionOptions } from 'bullmq';
import { pino } from 'pino';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryPush } from '../src/lib/push.js';
import { MemorySms } from '../src/lib/sms.js';
import { createSocketEmitter, type SocketEmitter } from '../src/workers/emitter.js';
import { bullConnection, closeQueues, createQueues, type Queues } from '../src/workers/queues.js';
import { startWorkers, type WorkerRuntime } from '../src/workers/runtime.js';
import { bearer, fixtures } from './fixtures.js';
import { buildTestApp, testEnv } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
type Envelope = { eventId: string; id: string; version: number; data: { status: string } };

const log = pino({ level: 'silent' });
const prefix = `test-${randomUUID()}`;
let ctx: Ctx;
let queues: Queues;
let connection: ConnectionOptions;
let emitter: SocketEmitter;
let runtime: WorkerRuntime | null = null;
let url = '';
const sockets: Socket[] = [];
const fx = fixtures(() => ctx);
const api = () => request(ctx.app.server);

let store: Awaited<ReturnType<typeof fx.store>>;
let customer: Awaited<ReturnType<typeof fx.customer>>;
let order: Order;

const until = async (check: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};

const start = () =>
  startWorkers({
    db: ctx.app.db,
    redis: ctx.app.redis,
    queues,
    emitter,
    connection,
    push: new MemoryPush(),
    sms: new MemorySms(),
    storage: ctx.app.storage,
    log,
    outboxPollMs: 100,
    prefix,
  });

async function open(token: string, rooms: string[]): Promise<Socket> {
  const s = connect(url, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { token },
  });
  sockets.push(s);
  await new Promise<void>((resolve, reject) => {
    s.once('connect', () => resolve());
    s.once('connect_error', reject);
  });
  for (const room of rooms) {
    const ack = (await s.timeout(2000).emitWithAck(SocketCommand.JOIN, { room })) as RoomAck;
    expect(ack, room).toEqual({ ok: true });
  }
  return s;
}

/** Next order.updated for our order with the given status. */
const next = (s: Socket, status: string) =>
  new Promise<Envelope>((resolve) => {
    const on = (p: Envelope) => {
      if (p.id !== order.id || p.data.status !== status) return;
      s.off(SocketEvent.ORDER_UPDATED, on);
      resolve(p);
    };
    s.on(SocketEvent.ORDER_UPDATED, on);
  });

const transition = (to: string, version: number) =>
  api()
    .post(`${store.base}/orders/${order.id}/transition`)
    .set(bearer(store.owner))
    .send({ to, version })
    .expect(200);

const outboxDone = (version: number) =>
  until(async () => {
    const rows = await ctx.app.db.outboxEvent.findMany({
      where: { aggregateId: order.id, version, event: SocketEvent.ORDER_UPDATED },
    });
    return rows.length > 0 && rows.every((r) => r.processedAt !== null);
  });

beforeAll(async () => {
  connection = bullConnection(testEnv().REDIS_URL);
  queues = createQueues(connection, prefix);
  ctx = await buildTestApp({ realtime: true, queues });
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  url = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
  // Earlier files leave unrelayed rows; the relay is ordered, so start from an empty outbox.
  await ctx.app.db.outboxEvent.updateMany({
    where: { processedAt: null },
    data: { processedAt: new Date() },
  });

  await fx.zone();
  store = await fx.store();
  const product = await fx.product(store.merchantId);
  customer = await fx.customer();
  const cart = (
    await api()
      .post('/v1/carts/items')
      .set(bearer(customer.token))
      .send({ merchantId: store.merchantId, productId: product.id, quantity: 1 })
      .expect(200)
  ).body as Cart;
  order = (
    await api()
      .post('/v1/orders')
      .set(bearer(customer.token))
      .set('Idempotency-Key', randomUUID())
      .send({ cartId: cart.id, addressId: customer.addressId, paymentMethod: 'cod' })
      .expect(201)
  ).body as Order;
  expect(order.status).toBe('placed');

  emitter = createSocketEmitter(testEnv().REDIS_URL);
  await until(async () => emitter.ready());
  runtime = await start();
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await runtime?.close();
  await emitter?.close();
  for (const q of Object.values(queues)) await q.obliterate({ force: true }).catch(() => {});
  await closeQueues(queues);
  await ctx?.close();
});

describe('2C acceptance', () => {
  let lastVersion = 0;

  it('customer and merchant both see the merchant accepting within 1 s', async () => {
    const c = await open(customer.token, [Rooms.order(order.id)]);
    const m = await open(store.owner, [Rooms.merchant(store.merchantId), Rooms.order(order.id)]);
    const both = Promise.all([next(c, 'confirmed'), next(m, 'confirmed')]);

    const started = Date.now();
    await api()
      .post(`${store.base}/orders/${order.id}/accept`)
      .set(bearer(store.owner))
      .send({ version: order.version, prepTimeMinutes: 15 })
      .expect(200);
    const [forCustomer, forMerchant] = await both;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(forCustomer.eventId).toBe(forMerchant.eventId);
    expect(forCustomer.version).toBeGreaterThan(order.version);
    lastVersion = forCustomer.version;
    c.disconnect();
  });

  it('a client reconnecting after missed events gets the current state over REST', async () => {
    // Customer is offline while the merchant starts preparing; the event goes nowhere.
    await transition('preparing', lastVersion);
    await outboxDone(lastVersion + 1);

    const c = await open(customer.token, [Rooms.order(order.id)]);
    const res = await api().get(`/v1/orders/${order.id}`).set(bearer(customer.token)).expect(200);
    const current = res.body as Order;
    expect(current.status).toBe('preparing');
    expect(current.version).toBeGreaterThan(lastVersion);
    lastVersion = current.version;

    // ...and live events flow again on the new connection.
    const ready = next(c, 'ready');
    await transition('ready', lastVersion);
    lastVersion = (await ready).version;
  });

  it('workers restarted mid-stream deliver what was queued while they were down', async () => {
    const c = await open(customer.token, [Rooms.order(order.id)]);
    await runtime?.close();
    runtime = null;

    // Written while no worker runs: an order change (outbox row) and a queued push job.
    const missed = next(c, 'cancelled');
    await api()
      .post(`${store.base}/orders/${order.id}/transition`)
      .set(bearer(store.owner))
      .send({ to: 'cancelled', version: lastVersion, reason: 'out of stock' })
      .expect(200);
    const job = await queues.notifications.add('push', {
      eventId: randomUUID(),
      event: SocketEvent.ORDER_UPDATED,
      userIds: [customer.userId],
      titleKey: 'notifications:orderCancelled.title',
      bodyKey: 'notifications:orderCancelled.body',
    });
    await new Promise((r) => setTimeout(r, 300));
    const pending = await ctx.app.db.outboxEvent.findFirst({
      where: { aggregateId: order.id, version: lastVersion + 1 },
    });
    expect(pending?.processedAt).toBeNull();
    expect(await job.getState()).toBe('waiting');

    runtime = await start();
    const got = await missed;
    expect(got.eventId).toBe(pending?.id);
    await outboxDone(lastVersion + 1);
    await until(async () => (await job.getState()) === 'completed');
  });
});
