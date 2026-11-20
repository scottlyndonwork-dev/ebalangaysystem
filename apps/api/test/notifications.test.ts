import { randomUUID } from 'node:crypto';
import { SocketEvent } from '@ebalangay/shared';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrderStatus } from '../src/generated/prisma/client.js';
import { MemoryPush } from '../src/lib/push.js';
import { MemorySms } from '../src/lib/sms.js';
import type { OutboxPush, PushJob } from '../src/modules/notifications/payload.js';
import {
  checkReceipts,
  deliverPush,
  type NotifyDeps,
  RECEIPTS_JOB,
} from '../src/modules/notifications/service.js';
import { assignRider } from '../src/modules/orders/dispatch.js';
import { transitionOrder } from '../src/modules/orders/transitions.js';
import { bullConnection, closeQueues, createQueues, type Queues } from '../src/workers/queues.js';
import { bearer, fixtures, must } from './fixtures.js';
import { buildTestApp, testEnv } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
let ctx: Ctx;
let queues: Queues;
let push: MemoryPush;
let sms: MemorySms;
const api = () => request(ctx.app.server);
const db = () => ctx.app.db;
const fx = fixtures(() => ctx);
const log = pino({ level: 'silent' });

const deps = (): NotifyDeps => ({
  db: db(),
  redis: ctx.app.redis,
  push,
  sms,
  queue: queues.notifications,
  log,
});

const token = () => `ExponentPushToken[${randomUUID()}]`;

async function recipient(opts: { locale?: 'en' | 'fil' | 'ceb'; app?: 'customer' | 'rider' } = {}) {
  const c = await fx.customer();
  const user = await db().user.update({
    where: { id: c.userId },
    data: { locale: opts.locale ?? 'en' },
  });
  const pushToken = token();
  await db().userDevice.create({
    data: {
      userId: c.userId,
      deviceId: randomUUID(),
      platform: 'android',
      app: opts.app ?? 'customer',
      pushToken,
    },
  });
  return { ...c, phone: must(user.phone), pushToken };
}

const job = (userIds: string[], extra: Partial<OutboxPush> = {}): PushJob => ({
  userIds,
  titleKey: 'notifications:orderDelivered.title',
  bodyKey: 'notifications:orderCancelled.body',
  params: { code: 'EB-1234' },
  eventId: randomUUID(),
  event: SocketEvent.ORDER_UPDATED,
  entityType: 'order',
  entityId: randomUUID(),
  ...extra,
});

beforeAll(async () => {
  ctx = await buildTestApp({ env: { RATE_LIMIT_ENABLED: 'false' } });
  queues = createQueues(bullConnection(testEnv().REDIS_URL), `test-${randomUUID()}`);
  await fx.zone();
});

afterAll(async () => {
  await queues.notifications.obliterate({ force: true });
  await closeQueues(queues);
  await ctx.close();
});

beforeEach(() => {
  push = new MemoryPush();
  sms = new MemorySms();
});

describe('deliverPush', () => {
  it('creates a localized in-app row, announces it, and pushes to the target app only', async () => {
    const u = await recipient({ locale: 'fil' });
    await db().userDevice.create({
      data: {
        userId: u.userId,
        deviceId: randomUUID(),
        platform: 'android',
        app: 'rider',
        pushToken: token(),
      },
    });
    const j = job([u.userId], { app: 'customer' });

    const r = await deliverPush(deps(), j);
    expect(r).toEqual({ users: 1, inApp: 1, push: 1, sms: 0 });

    const n = must(await db().notification.findFirst({ where: { userId: u.userId } }));
    expect(n).toMatchObject({
      type: 'order',
      title: 'Naihatid na',
      body: 'Kinansela ang order EB-1234.',
      dedupeKey: `event:${j.eventId}`,
      data: { event: 'order.updated', orderId: j.entityId, entityType: 'order' },
    });
    const outbox = must(
      await db().outboxEvent.findFirst({
        where: { aggregateType: 'notification', aggregateId: n.id },
      }),
    );
    expect(outbox).toMatchObject({
      event: SocketEvent.NOTIFICATION_CREATED,
      rooms: [`user:${u.userId}`],
    });
    expect(push.sent).toEqual([expect.objectContaining({ to: u.pushToken, title: 'Naihatid na' })]);
    // Receipts are checked later on the same queue.
    const receipts = must(await queues.notifications.getJob(`receipts-${j.eventId}-${u.userId}`));
    expect(receipts.name).toBe(RECEIPTS_JOB);
  });

  it('sends the SMS for critical alerts and is idempotent on retry / duplicate dedupe key', async () => {
    const u = await recipient();
    const j = job([u.userId], {
      dedupeKey: `order:${randomUUID()}:rider_nearby`,
      smsKey: 'notifications:riderNearby.sms',
    });
    await deliverPush(deps(), j);
    // A replayed job, and a later event with the same dedupe key, deliver nothing new.
    const again = await deliverPush(deps(), j);
    const later = await deliverPush(deps(), { ...j, eventId: randomUUID() });
    expect(again).toMatchObject({ inApp: 0, push: 0, sms: 0 });
    expect(later).toMatchObject({ inApp: 0, push: 0, sms: 0 });

    expect(await db().notification.count({ where: { userId: u.userId } })).toBe(1);
    expect(push.sent).toHaveLength(1);
    expect(sms.sent).toEqual([
      { phone: u.phone, message: 'eBalangay: Your rider is almost there with order EB-1234.' },
    ]);
  });

  it('respects per-category preferences', async () => {
    const u = await recipient();
    await api()
      .put('/v1/me/notifications/preferences')
      .set(bearer(u.token))
      .send({ preferences: [{ category: 'order', push: false, sms: false }] })
      .expect(200);

    const r = await deliverPush(
      deps(),
      job([u.userId], { smsKey: 'notifications:orderDelivered.sms' }),
    );
    expect(r).toMatchObject({ inApp: 1, push: 0, sms: 0 });
    expect(push.sent).toHaveLength(0);
    expect(sms.sent).toHaveLength(0);

    // Other categories are untouched.
    const promo = await deliverPush(deps(), job([u.userId], { category: 'promo' }));
    expect(promo).toMatchObject({ inApp: 1, push: 1 });
  });

  it('a failed push is retried without duplicating the in-app row', async () => {
    const u = await recipient();
    const j = job([u.userId]);
    push.failNext = 1;
    await expect(deliverPush(deps(), j)).rejects.toThrow(/delivery failed/);
    expect(await db().notification.count({ where: { userId: u.userId } })).toBe(1);

    const r = await deliverPush(deps(), j);
    expect(r).toMatchObject({ inApp: 0, push: 1 });
    expect(await db().notification.count({ where: { userId: u.userId } })).toBe(1);
  });

  it('clears tokens Expo reports as not registered (ticket and receipt)', async () => {
    const a = await recipient();
    push.goneTokens.add(a.pushToken);
    await deliverPush(deps(), job([a.userId]));
    expect(await db().userDevice.count({ where: { pushToken: a.pushToken } })).toBe(0);

    const b = await recipient();
    push.receiptOutcomes.set('r-x', { ok: false, error: 'gone', deviceGone: true });
    const r = await checkReceipts(deps(), { tickets: [{ id: 'r-x', token: b.pushToken }] });
    expect(r).toEqual({ checked: 1, cleared: 1 });
    expect(await db().userDevice.count({ where: { pushToken: b.pushToken } })).toBe(0);
  });

  it('skips users who are not active', async () => {
    const u = await recipient();
    await db().user.update({ where: { id: u.userId }, data: { status: 'suspended' } });
    expect(await deliverPush(deps(), job([u.userId]))).toMatchObject({ users: 0, push: 0 });
  });
});

describe('/v1/me/notifications', () => {
  it('lists newest first with cursor pages, counts unread, marks read (own only)', async () => {
    const u = await recipient();
    const other = await recipient();
    for (let i = 0; i < 3; i++) await deliverPush(deps(), job([u.userId]));
    await deliverPush(deps(), job([other.userId]));

    const p1 = await api().get('/v1/me/notifications?limit=2').set(bearer(u.token)).expect(200);
    const body1 = p1.body as { items: { id: string; createdAt: string }[]; nextCursor: string };
    expect(body1.items).toHaveLength(2);
    const p2 = await api()
      .get(`/v1/me/notifications?limit=2&cursor=${body1.nextCursor}`)
      .set(bearer(u.token))
      .expect(200);
    const body2 = p2.body as { items: { id: string }[]; nextCursor: string | null };
    expect(body2.items).toHaveLength(1);
    expect(body2.nextCursor).toBeNull();
    const ids = [...body1.items, ...body2.items].map((x) => x.id);
    expect(new Set(ids).size).toBe(3);

    const count = () =>
      api().get('/v1/me/notifications/unread-count').set(bearer(u.token)).expect(200);
    expect((await count()).body).toEqual({ count: 3 });

    const otherId = must(await db().notification.findFirst({ where: { userId: other.userId } })).id;
    const one = await api()
      .post('/v1/me/notifications/read')
      .set(bearer(u.token))
      .send({ ids: [ids[0], otherId] })
      .expect(200);
    expect(one.body).toEqual({ updated: 1 });
    expect((await count()).body).toEqual({ count: 2 });
    const unread = await api()
      .get('/v1/me/notifications?unreadOnly=true')
      .set(bearer(u.token))
      .expect(200);
    expect((unread.body as { items: unknown[] }).items).toHaveLength(2);

    await api()
      .post('/v1/me/notifications/read')
      .set(bearer(u.token))
      .send({ all: true })
      .expect(200);
    expect((await count()).body).toEqual({ count: 0 });
    // The other user's row was never touched.
    const theirs = must(await db().notification.findUnique({ where: { id: otherId } }));
    expect(theirs.readAt).toBeNull();

    await api().post('/v1/me/notifications/read').set(bearer(u.token)).send({}).expect(400);
    await api().get('/v1/me/notifications').expect(401);
  });

  it('preferences default to on and keep channels that were not sent', async () => {
    const u = await recipient();
    const get = await api()
      .get('/v1/me/notifications/preferences')
      .set(bearer(u.token))
      .expect(200);
    const prefs = (get.body as { preferences: { category: string; push: boolean }[] }).preferences;
    expect(prefs).toHaveLength(5);
    expect(prefs.every((p) => p.push)).toBe(true);

    await api()
      .put('/v1/me/notifications/preferences')
      .set(bearer(u.token))
      .send({ preferences: [{ category: 'promo', sms: false }] })
      .expect(200);
    const put = await api()
      .put('/v1/me/notifications/preferences')
      .set(bearer(u.token))
      .send({ preferences: [{ category: 'promo', push: false }] })
      .expect(200);
    const promo = (
      put.body as {
        preferences: { category: string; push: boolean; sms: boolean; inApp: boolean }[];
      }
    ).preferences.find((p) => p.category === 'promo');
    expect(promo).toEqual({ category: 'promo', push: false, sms: false, inApp: true });

    await api()
      .put('/v1/me/notifications/preferences')
      .set(bearer(u.token))
      .send({ preferences: [{ category: 'promo' }, { category: 'promo' }] })
      .expect(400);
  });
});

describe('order pushes', () => {
  const move = (orderId: string, to: OrderStatus, actor: 'merchant' | 'rider') =>
    db().$transaction((tx) => transitionOrder(tx, { orderId, to, actor, actorUserId: null }));

  it('COD pick-up sends the cash reminder (push + SMS) to the customer app', async () => {
    const s = await fx.store();
    const item = await fx.product(s.merchantId, { price: 10_000 });
    const c = await fx.customer();
    const r = await fx.rider();
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

    const newOrder = must(
      await db().outboxEvent.findFirst({
        where: { aggregateId: orderId, event: SocketEvent.MERCHANT_NEW_ORDER },
      }),
    );
    expect(newOrder.push).toMatchObject({ app: 'merchant', dedupeKey: `order:${orderId}:new` });

    for (const to of ['confirmed', 'preparing', 'ready'] as const)
      await move(orderId, to, 'merchant');
    await db().$transaction((tx) =>
      assignRider(tx, { orderId, riderId: r.riderId, actor: 'system' }),
    );
    await move(orderId, 'rider_at_merchant', 'rider');
    await move(orderId, 'picked_up', 'rider');

    const order = must(await db().order.findUnique({ where: { id: orderId } }));
    const events = await db().outboxEvent.findMany({
      where: { aggregateId: orderId, event: SocketEvent.ORDER_UPDATED },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(events[0]?.push).toMatchObject({
      userIds: [c.userId],
      titleKey: 'notifications:codReminder.title',
      smsKey: 'notifications:codReminder.sms',
      app: 'customer',
      dedupeKey: `order:${orderId}:picked_up`,
      params: { code: order.code, amount: '₱' + (Number(order.totalCentavos) / 100).toFixed(2) },
    });
  });
});
