import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  type PublicTracking,
  type RiderLocationResult,
  type RoomAck,
  Rooms,
  SocketCommand,
  SocketEvent,
  socketEventSchemas,
  type TrackingLink,
} from '@ebalangay/shared';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderStatus } from '../src/generated/prisma/client.js';
import { assignRider } from '../src/modules/orders/dispatch.js';
import { transitionOrder } from '../src/modules/orders/transitions.js';
import { flushBreadcrumbs } from '../src/modules/tracking/breadcrumbs.js';
import { LocationKeys } from '../src/modules/tracking/location.js';
import { signTrackingToken } from '../src/modules/tracking/token.js';
import { bearer, fixtures, must } from './fixtures.js';
import { buildTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
let ctx: Ctx;
let url = '';
const api = () => request(ctx.app.server);
const db = () => ctx.app.db;
const fx = fixtures(() => ctx);
const sockets: Socket[] = [];

type Rider = Awaited<ReturnType<typeof fx.rider>>;
type Customer = Awaited<ReturnType<typeof fx.customer>>;

/** Metres north of the fixture centre (the store is at 200 m, drop-offs at 1000 m). */
const north = (m: number) => ({ lat: fx.center.lat + m / 111_320, lng: fx.center.lng });
const ping = (m: number, at = new Date()) => ({
  ...north(m),
  heading: 0,
  speedMps: 5,
  accuracyM: 8,
  recordedAt: at.toISOString(),
});

const move = (orderId: string, to: OrderStatus, actor: 'merchant' | 'rider') =>
  db().$transaction((tx) => transitionOrder(tx, { orderId, to, actor, actorUserId: null }));

/** A COD order from a fresh customer, walked up to `until` with a fresh rider. */
async function liveOrder(until: OrderStatus = 'on_the_way') {
  const s = await fx.store();
  const item = await fx.product(s.merchantId, { price: 10_000 });
  const c = await fx.customer();
  const r = await fx.rider();
  await db().user.update({
    where: { id: r.userId },
    data: { firstName: 'Pedro', lastName: 'Santos' },
  });
  await db().rider.update({ where: { id: r.riderId }, data: { plateNumber: 'ABC 1234' } });
  const cart = await api()
    .post('/v1/carts/items')
    .set(bearer(c.token))
    .send({ merchantId: s.merchantId, productId: item.id, quantity: 1 })
    .expect(200);
  const placed = await api()
    .post('/v1/orders')
    .set(bearer(c.token))
    .set('Idempotency-Key', randomUUID())
    .send({
      cartId: (cart.body as { id: string }).id,
      addressId: c.addressId,
      paymentMethod: 'cod',
    })
    .expect(201);
  const orderId = (placed.body as { id: string }).id;
  const path: [OrderStatus, 'merchant' | 'rider' | 'assign'][] = [
    ['confirmed', 'merchant'],
    ['preparing', 'merchant'],
    ['ready', 'merchant'],
    ['rider_assigned', 'assign'],
    ['rider_at_merchant', 'rider'],
    ['picked_up', 'rider'],
    ['on_the_way', 'rider'],
  ];
  for (const [to, actor] of path) {
    if (actor === 'assign') {
      await db().$transaction((tx) =>
        assignRider(tx, { orderId, riderId: r.riderId, actor: 'system' }),
      );
    } else {
      await move(orderId, to, actor);
    }
    if (to === until) break;
  }
  return { orderId, store: s, customer: c, rider: r };
}

const postPings = (r: Rider, pings: ReturnType<typeof ping>[]) =>
  api().post('/v1/rider/location').set(bearer(r.token)).send({ pings });

async function open(token: string): Promise<Socket> {
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
  return s;
}

const send = (s: Socket, event: string, payload: unknown) =>
  new Promise<RoomAck>((resolve) => s.emit(event, payload, (a: RoomAck) => resolve(a)));

beforeAll(async () => {
  ctx = await buildTestApp({ realtime: true, env: { RATE_LIMIT_ENABLED: 'false' } });
  await fx.zone();
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  url = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await ctx.close();
});

describe('delivery job', () => {
  it('assigning a rider opens a delivery with pickup + dropoff legs that follows the order', async () => {
    const { orderId, rider } = await liveOrder('rider_assigned');
    const delivery = await db().delivery.findFirstOrThrow({
      where: { legs: { some: { orderId } } },
      include: { legs: { orderBy: { sequence: 'asc' } } },
    });
    expect(delivery).toMatchObject({ riderId: rider.riderId, status: 'assigned' });
    expect(delivery.distanceMeters).toBeGreaterThan(700);
    expect(delivery.legs.map((l) => l.kind)).toEqual(['pickup', 'dropoff']);

    for (const to of ['rider_at_merchant', 'picked_up', 'on_the_way', 'delivered'] as const) {
      await move(orderId, to, 'rider');
    }
    const done = await db().delivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(done.status).toBe('delivered');
    expect(done.completedAt).not.toBeNull();
  });
});

describe('rider location', () => {
  it('only approved riders may report', async () => {
    const c = await fx.customer();
    await api()
      .post('/v1/rider/location')
      .set(bearer(c.token))
      .send({ pings: [ping(0)] })
      .expect(403);
    const r = await fx.rider();
    await db().rider.update({
      where: { id: r.riderId },
      data: { verificationStatus: 'suspended' },
    });
    await postPings(r, [ping(0)]).expect(403);
  });

  it('stores the latest position in Redis, drops stale/replayed pings and queues breadcrumbs', async () => {
    const { orderId, rider } = await liveOrder();
    const t0 = Date.now();
    const batch = [ping(250, new Date(t0 - 10_000)), ping(300, new Date(t0 - 5_000))];
    const first = (await postPings(rider, batch).expect(200)).body as RiderLocationResult;
    expect(first).toEqual({ accepted: 2, nearbyOrderIds: [] });

    const pos = await ctx.app.redis.geopos(LocationKeys.geo, rider.riderId);
    expect(Number(pos[0]?.[1])).toBeCloseTo(north(300).lat, 4);
    const last = await ctx.app.redis.hgetall(LocationKeys.last(rider.riderId));
    expect(Number(last.at)).toBe(t0 - 5_000);

    // Same batch again (app retry) and a ping from an hour ago: nothing new.
    const again = (
      await postPings(rider, [...batch, ping(0, new Date(t0 - 3_600_000))]).expect(200)
    ).body as RiderLocationResult;
    expect(again.accepted).toBe(0);

    const r = await flushBreadcrumbs(db(), ctx.app.redis);
    expect(r.locked).toBe(true);
    const delivery = await db().delivery.findFirstOrThrow({
      where: { legs: { some: { orderId } } },
    });
    const crumbs = await db().deliveryBreadcrumb.findMany({
      where: { deliveryId: delivery.id },
      orderBy: { recordedAt: 'asc' },
    });
    expect(crumbs).toHaveLength(2);
    expect(crumbs[0]).toMatchObject({ riderId: rider.riderId, accuracyM: 8, speedMps: 5 });
    const snap = await db().rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(snap.lastLat).toBeCloseTo(north(300).lat, 6);
    expect(snap.lastLocationAt?.getTime()).toBe(t0 - 5_000);

    // Nothing left to write; a second flush adds no rows.
    await flushBreadcrumbs(db(), ctx.app.redis);
    expect(await db().deliveryBreadcrumb.count({ where: { deliveryId: delivery.id } })).toBe(2);
  });

  it('a re-run after a crash before the trim writes no duplicates', async () => {
    const { orderId, rider } = await liveOrder();
    await postPings(rider, [ping(300)]).expect(200);
    const queued = await ctx.app.redis.lrange(LocationKeys.crumbs, 0, -1);
    await flushBreadcrumbs(db(), ctx.app.redis);
    // Simulate the crash: the same rows are back on the list.
    await ctx.app.redis.rpush(LocationKeys.crumbs, ...queued);
    await flushBreadcrumbs(db(), ctx.app.redis);
    const delivery = await db().delivery.findFirstOrThrow({
      where: { legs: { some: { orderId } } },
    });
    expect(await db().deliveryBreadcrumb.count({ where: { deliveryId: delivery.id } })).toBe(1);
  });

  it('moves the order to rider_nearby about 2 minutes out and pushes the customer', async () => {
    const { orderId, rider, customer } = await liveOrder();
    const far = (await postPings(rider, [ping(200)]).expect(200)).body as RiderLocationResult;
    expect(far.nearbyOrderIds).toEqual([]);
    expect((await db().order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      'on_the_way',
    );

    const near = (await postPings(rider, [ping(900)]).expect(200)).body as RiderLocationResult;
    expect(near.nearbyOrderIds).toEqual([orderId]);
    const o = await db().order.findUniqueOrThrow({ where: { id: orderId } });
    expect(o.status).toBe('rider_nearby');
    const history = await db().orderStatusHistory.findFirstOrThrow({
      where: { orderId, toStatus: 'rider_nearby' },
    });
    expect(history).toMatchObject({ actor: 'system', reason: 'gps' });
    const event = await db().outboxEvent.findFirstOrThrow({
      where: { aggregateId: orderId, event: 'order.updated', version: o.version },
    });
    expect(event.push).toMatchObject({
      userIds: [customer.userId],
      titleKey: 'notifications:riderNearby.title',
    });

    // Already nearby: further pings don't transition again.
    const later = (await postPings(rider, [ping(950)]).expect(200)).body as RiderLocationResult;
    expect(later.nearbyOrderIds).toEqual([]);
  });

  it('socket pings reach the order room with an ETA; only rider apps may send', async () => {
    const { orderId, rider, customer } = await liveOrder();
    const watcher = await open(customer.token);
    expect(await send(watcher, SocketCommand.JOIN, { room: Rooms.order(orderId) })).toEqual({
      ok: true,
    });
    expect(await send(watcher, SocketCommand.RIDER_LOCATION, ping(300))).toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });

    const received = new Promise<unknown>((resolve) =>
      watcher.once(SocketEvent.RIDER_LOCATION, resolve),
    );
    const riderSocket = await open(rider.token);
    expect(await send(riderSocket, SocketCommand.RIDER_LOCATION, { lat: 'x' })).toMatchObject({
      ok: false,
      error: 'VALIDATION_FAILED',
    });
    expect(await send(riderSocket, SocketCommand.RIDER_LOCATION, ping(300))).toEqual({ ok: true });
    const payload = socketEventSchemas[SocketEvent.RIDER_LOCATION].parse(await received);
    expect(payload).toMatchObject({ id: rider.riderId, data: { orderId, heading: 0 } });
    expect(payload.data.etaSeconds).toBeGreaterThan(120);
    // Too soon after the last one.
    expect(await send(riderSocket, SocketCommand.RIDER_LOCATION, ping(310))).toEqual({
      ok: false,
      error: 'RATE_LIMITED',
    });
  });
});

describe('public tracking link', () => {
  const linkFor = (c: Customer, orderId: string) =>
    api().get(`/v1/orders/${orderId}/tracking-link`).set(bearer(c.token));

  it('only the customer gets the link; it shows status, store and rider first name + plate', async () => {
    const { orderId, rider, customer } = await liveOrder();
    await linkFor(await fx.customer(), orderId).expect(404);
    const link = (await linkFor(customer, orderId).expect(200)).body as TrackingLink;
    expect(link.expiresAt).toBeNull();
    expect(link.path).toBe(`/v1/track/${link.token}`);

    await postPings(rider, [ping(400)]).expect(200);
    const res = await api().get(link.path).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const t = res.body as PublicTracking;
    expect(t).toMatchObject({
      status: 'on_the_way',
      rider: { firstName: 'Pedro', plateNumber: 'ABC 1234', vehicleType: 'motorcycle' },
    });
    expect(must(t.rider?.location).lat).toBeCloseTo(north(400).lat, 5);
    // No personal data beyond first name and plate.
    const text = JSON.stringify(t);
    for (const secret of ['Santos', 'Juan', '+639', 'Test St']) expect(text).not.toContain(secret);
  });

  it('rejects forged tokens and expires an hour after delivery', async () => {
    const { orderId, customer } = await liveOrder();
    const { token } = (await linkFor(customer, orderId).expect(200)).body as TrackingLink;
    const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    await api().get(`/v1/track/${forged}`).expect(404);
    await api()
      .get(`/v1/track/${signTrackingToken('another-secret-0123456789abcdef0123', orderId)}`)
      .expect(404);

    await move(orderId, 'delivered', 'rider');
    const after = (await linkFor(customer, orderId).expect(200)).body as TrackingLink;
    expect(Date.parse(must(after.expiresAt))).toBeGreaterThan(Date.now() + 59 * 60_000);
    const live = (await api().get(`/v1/track/${token}`).expect(200)).body as PublicTracking;
    expect(live).toMatchObject({ status: 'delivered', rider: { location: null } });

    await db().order.update({
      where: { id: orderId },
      data: { deliveredAt: new Date(Date.now() - 61 * 60_000) },
    });
    await api().get(`/v1/track/${token}`).expect(404);
  });
});
