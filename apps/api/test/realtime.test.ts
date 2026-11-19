import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type Cart, type Order, type RoomAck, Rooms, SocketCommand } from '@ebalangay/shared';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_COOKIE } from '../src/plugins/auth.js';
import { MAX_ROOMS_PER_SOCKET } from '../src/plugins/socket.js';
import { bearer, fixtures, must } from './fixtures.js';
import { buildTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
const ADMIN_IP = '10.9.9.9';
const env = { ADMIN_IP_ALLOWLIST: ADMIN_IP, TRUST_PROXY_HOPS: '1' };

// Two API instances sharing Redis: events must cross instances through the adapter.
let a: Ctx;
let b: Ctx;
let urlA = '';
let urlB = '';
const fx = fixtures(() => a);
const sockets: Socket[] = [];

async function listen(ctx: Ctx): Promise<string> {
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  return `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
}

function client(url: string, token: string | undefined, ip = '100.1.1.1'): Socket {
  const s = connect(url, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: token ? { token } : {},
    extraHeaders: { 'x-forwarded-for': ip },
  });
  sockets.push(s);
  return s;
}

const connected = (s: Socket) =>
  new Promise<void>((resolve, reject) => {
    s.once('connect', () => resolve());
    s.once('connect_error', reject);
  });

const join = (s: Socket, room: string) =>
  s.timeout(2000).emitWithAck(SocketCommand.JOIN, { room }) as Promise<RoomAck>;

async function open(token: string, ip?: string, url = urlA): Promise<Socket> {
  const s = client(url, token, ip);
  await connected(s);
  return s;
}

let store: Awaited<ReturnType<typeof fx.store>>;
let customer: Awaited<ReturnType<typeof fx.customer>>;
let rider: Awaited<ReturnType<typeof fx.rider>>;
let order: Order;
let zoneId = '';

beforeAll(async () => {
  a = await buildTestApp({ realtime: true, env });
  b = await buildTestApp({ realtime: true, env });
  urlA = await listen(a);
  urlB = await listen(b);

  zoneId = (await fx.zone()).id;
  store = await fx.store();
  const product = await fx.product(store.merchantId);
  customer = await fx.customer();
  rider = await fx.rider();

  const api = () => request(a.app.server);
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
});

afterEach(() => {
  for (const s of sockets.splice(0)) s.disconnect();
});

afterAll(async () => {
  await b?.close();
  await a?.close();
});

describe('handshake', () => {
  it('rejects a missing, bad or non-access token', async () => {
    for (const token of [
      undefined,
      'garbage',
      a.app.jwt.sign({
        typ: 'mfa',
        sub: randomUUID(),
        app: 'admin-web',
        jti: randomUUID(),
        enroll: false,
      }),
    ]) {
      const err = await connected(client(urlA, token)).catch((e: Error) => e);
      expect((err as Error).message).toBe('UNAUTHENTICATED');
    }
  });

  it('accepts the access cookie (web)', async () => {
    const s = connect(urlA, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(store.owner)}` },
    });
    sockets.push(s);
    const ok = await connected(s).then(
      () => true,
      () => false,
    );
    expect(ok).toBe(true);
  });

  it('drops the socket when the access token expires', async () => {
    const short = a.app.jwt.sign(
      {
        typ: 'access',
        sub: customer.userId,
        roles: ['customer'],
        app: 'customer',
        sid: randomUUID(),
      },
      { expiresIn: '1s' },
    );
    const s = await open(short);
    const reason = await new Promise<string>((resolve) => s.once('disconnect', resolve));
    expect(reason).toBe('io server disconnect');
  });
});

describe('room authorisation', () => {
  it('customer: own user + order rooms only', async () => {
    const s = await open(customer.token);
    expect((await join(s, Rooms.user(customer.userId))).ok).toBe(true);
    expect((await join(s, Rooms.order(order.id))).ok).toBe(true);
    expect((await join(s, Rooms.user(store.ownerId))).ok).toBe(false);
    expect((await join(s, Rooms.merchant(store.merchantId))).ok).toBe(false);
    expect((await join(s, Rooms.zone(zoneId))).ok).toBe(false);
    expect((await join(s, Rooms.admin())).ok).toBe(false);
    expect((await join(s, 'nonsense')).ok).toBe(false);

    const other = await fx.customer();
    const o = await open(other.token);
    expect((await join(o, Rooms.order(order.id))).ok).toBe(false);
  });

  it('merchant staff: own merchant + its orders, from merchant apps only', async () => {
    const s = await open(store.kitchen);
    expect((await join(s, Rooms.merchant(store.merchantId))).ok).toBe(true);
    expect((await join(s, Rooms.order(order.id))).ok).toBe(true);

    const otherStore = await fx.store();
    expect((await join(s, Rooms.merchant(otherStore.merchantId))).ok).toBe(false);
    const o = await open(otherStore.owner);
    expect((await join(o, Rooms.order(order.id))).ok).toBe(false);

    const buyer = await open(store.ownerAsBuyer);
    expect((await join(buyer, Rooms.merchant(store.merchantId))).ok).toBe(false);
  });

  it('deactivated staff can no longer join', async () => {
    const s2 = await fx.store();
    await a.app.db.merchantStaff.updateMany({
      where: { merchantId: s2.merchantId, rolePreset: 'kitchen' },
      data: { isActive: false },
    });
    const s = await open(s2.kitchen);
    expect((await join(s, Rooms.merchant(s2.merchantId))).ok).toBe(false);
  });

  it('rider: own rider + zone rooms; order room only while assigned and live', async () => {
    const s = await open(rider.token);
    expect((await join(s, Rooms.rider(rider.riderId))).ok).toBe(true);
    expect((await join(s, Rooms.zone(zoneId))).ok).toBe(true);
    expect((await join(s, Rooms.zone(randomUUID()))).ok).toBe(false);
    expect((await join(s, Rooms.order(order.id))).ok).toBe(false);

    const other = await fx.rider();
    expect((await join(s, Rooms.rider(other.riderId))).ok).toBe(false);

    await a.app.db.order.update({ where: { id: order.id }, data: { riderId: rider.riderId } });
    try {
      expect((await join(s, Rooms.order(order.id))).ok).toBe(true);
      const o = await open(other.token);
      expect((await join(o, Rooms.order(order.id))).ok).toBe(false);

      await a.app.db.order.update({ where: { id: order.id }, data: { status: 'delivered' } });
      const late = await open(rider.token);
      expect((await join(late, Rooms.order(order.id))).ok).toBe(false);
    } finally {
      await a.app.db.order.update({
        where: { id: order.id },
        data: { riderId: null, status: order.status },
      });
    }
  });

  it('unapproved rider cannot join zone rooms', async () => {
    const r = await fx.rider();
    await a.app.db.rider.update({
      where: { id: r.riderId },
      data: { verificationStatus: 'suspended' },
    });
    const s = await open(r.token);
    expect((await join(s, Rooms.zone(zoneId))).ok).toBe(false);
  });

  it('admin: admin-web + admin role + allowlisted IP', async () => {
    const admin = await fx.user(['admin']);
    const token = fx.tokenFor(admin.id, ['admin'], 'admin-web');
    const s = await open(token, ADMIN_IP);
    expect((await join(s, Rooms.admin())).ok).toBe(true);
    expect((await join(s, Rooms.order(order.id))).ok).toBe(true);
    expect((await join(s, Rooms.zone(zoneId))).ok).toBe(true);
    expect((await join(s, Rooms.merchant(store.merchantId))).ok).toBe(false);

    const offsite = await open(token, '100.2.2.2');
    expect((await join(offsite, Rooms.admin())).ok).toBe(false);
    const wrongApp = await open(fx.tokenFor(admin.id, ['admin'], 'customer'), ADMIN_IP);
    expect((await join(wrongApp, Rooms.admin())).ok).toBe(false);
  });

  it('caps rooms per socket and keeps the user room on leave', async () => {
    const admin = await fx.user(['admin']);
    const s = await open(fx.tokenFor(admin.id, ['admin'], 'admin-web'), ADMIN_IP);
    const zones = Array.from({ length: MAX_ROOMS_PER_SOCKET }, () => Rooms.zone(randomUUID()));
    const acks = await Promise.all(zones.map((z) => join(s, z)));
    expect(acks.filter((x) => x.ok)).toHaveLength(MAX_ROOMS_PER_SOCKET - 1);
    expect(acks.find((x) => !x.ok)?.error).toBe('TOO_MANY_ROOMS');

    await s.timeout(2000).emitWithAck(SocketCommand.LEAVE, { room: Rooms.user(admin.id) });
    const got = new Promise((resolve) => s.once('ping.test', resolve));
    must(a.io).to(Rooms.user(admin.id)).emit('ping.test', 1);
    expect(await got).toBe(1);
  });
});

describe('delivery across instances', () => {
  it('customer on A and merchant on B both get an order-room event within 1 s', async () => {
    const c = await open(customer.token, undefined, urlA);
    const m = await open(store.owner, undefined, urlB);
    expect((await join(c, Rooms.order(order.id))).ok).toBe(true);
    expect((await join(m, Rooms.order(order.id))).ok).toBe(true);

    const started = Date.now();
    const wait = (s: Socket) => new Promise((resolve) => s.once('order.updated', resolve));
    const both = Promise.all([wait(c), wait(m)]);
    // Emitted on B: reaches A's socket only via the Redis adapter.
    must(b.io).to(Rooms.order(order.id)).emit('order.updated', { id: order.id, version: 99 });
    const [x, y] = await both;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(x).toEqual({ id: order.id, version: 99 });
    expect(y).toEqual(x);
  });

  it('a non-member never receives the room event', async () => {
    const other = await fx.customer();
    const s = await open(other.token);
    let leaked = false;
    s.on('order.updated', () => (leaked = true));
    must(a.io).to(Rooms.order(order.id)).emit('order.updated', { id: order.id, version: 100 });
    await new Promise((r) => setTimeout(r, 200));
    expect(leaked).toBe(false);
  });
});
