import { randomUUID } from 'node:crypto';
import type {
  Cart,
  GroupCart,
  MerchantOrder,
  Order,
  OrderChatMessage,
  PrepSuggestion,
} from '@ebalangay/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignRider } from '../src/modules/orders/dispatch.js';
import { bearer, fixtures, must } from './fixtures.js';
import { buildTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
let ctx: Ctx;
const api = () => request(ctx.app.server);
const db = () => ctx.app.db;
const fx = fixtures(() => ctx);

type Store = Awaited<ReturnType<typeof fx.store>>;
type Customer = Awaited<ReturnType<typeof fx.customer>>;
type Rider = Awaited<ReturnType<typeof fx.rider>>;

async function cartWith(c: Customer, s: Store, productId: string, quantity = 1) {
  const res = await api()
    .post('/v1/carts/items')
    .set(bearer(c.token))
    .send({ merchantId: s.merchantId, productId, quantity })
    .expect(200);
  return res.body as Cart;
}

function placeReq(c: Customer, body: Record<string, unknown>, key: string | null = randomUUID()) {
  const req = api().post('/v1/orders').set(bearer(c.token));
  if (key) req.set('Idempotency-Key', key);
  return req.send({ addressId: c.addressId, paymentMethod: 'cod', ...body });
}

async function place(
  c: Customer,
  s: Store,
  productId: string,
  quantity = 1,
  body: Record<string, unknown> = {},
) {
  const cart = await cartWith(c, s, productId, quantity);
  const res = await placeReq(c, { cartId: cart.id, ...body }).expect(201);
  return res.body as Order;
}

const merchantPost = (s: Store, orderId: string, action: string, body: object, token = s.owner) =>
  api().post(`${s.base}/orders/${orderId}/${action}`).set(bearer(token)).send(body);

const riderMove = (r: Rider, o: { id: string; version: number }, to: string) =>
  api()
    .post(`/v1/rider/orders/${o.id}/transition`)
    .set(bearer(r.token))
    .send({ to, version: o.version });

const stockOf = async (productId: string) =>
  (await db().inventoryLevel.findFirstOrThrow({ where: { productId, variantId: null } })).quantity;

const assign = (orderId: string, riderId: string) =>
  db().$transaction((tx) => assignRider(tx, { orderId, riderId, actor: 'system' }));

beforeAll(async () => {
  ctx = await buildTestApp({ env: { RATE_LIMIT_ENABLED: 'false' } });
  await fx.zone();
});
afterAll(async () => {
  await ctx.close();
});

describe('place order', () => {
  let s: Store;
  let item: Awaited<ReturnType<typeof fx.product>>;

  beforeAll(async () => {
    s = await fx.store();
    item = await fx.product(s.merchantId, { price: 10_000, stock: 10 });
  });

  it('re-prices the cart, reserves stock, empties the cart and is idempotent', async () => {
    const c = await fx.customer();
    const cart = await cartWith(c, s, item.id, 2);
    const key = randomUUID();
    const body = { cartId: cart.id, tipCentavos: 2_000 };

    await placeReq(c, body, null).expect(400);
    const first = (await placeReq(c, body, key).expect(201)).body as Order;
    expect(first).toMatchObject({ status: 'placed', type: 'regular', version: 0 });
    expect(first.code).toMatch(/^EB-[2-9A-HJ-NP-Z]{6}$/);
    expect(first.pricing).toMatchObject({
      ...cart.pricing,
      tipCentavos: 2_000,
      totalCentavos: cart.pricing.totalCentavos + 2_000,
      amountDueCentavos: cart.pricing.totalCentavos + 2_000,
    });
    expect(first.items).toMatchObject([
      { productId: item.id, quantity: 2, lineTotalCentavos: 20_000 },
    ]);
    expect(first.deliveryAddress?.recipientName).toBe('Juan Dela Cruz');
    expect(await stockOf(item.id)).toBe(8);
    expect(await db().cart.findUnique({ where: { id: cart.id } })).toBeNull();

    // Same key + same body: same order, no second charge.
    const replay = (await placeReq(c, body, key).expect(200)).body as Order;
    expect(replay.id).toBe(first.id);
    // Same key, different body.
    const conflict = await placeReq(c, { ...body, tipCentavos: 0 }, key).expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    const history = await db().orderStatusHistory.findMany({ where: { orderId: first.id } });
    expect(history).toMatchObject([{ fromStatus: null, toStatus: 'placed', actor: 'customer' }]);
    const events = await db().outboxEvent.findMany({
      where: { aggregateId: first.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.event).sort()).toEqual(['merchant.new_order', 'order.updated']);
    expect(must(events.find((e) => e.event === 'merchant.new_order')).rooms).toEqual([
      `merchant:${s.merchantId}`,
    ]);
  });

  it('places one order when the same cart is submitted twice at once', async () => {
    const c = await fx.customer();
    const cart = await cartWith(c, s, item.id);
    const results = await Promise.all([
      placeReq(c, { cartId: cart.id }),
      placeReq(c, { cartId: cart.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 404]);
    expect(await db().order.count({ where: { customerId: c.userId } })).toBe(1);
  });

  it('keeps online payments in pending_payment without alerting the store', async () => {
    const c = await fx.customer();
    const o = await place(c, s, item.id, 1, { paymentMethod: 'gcash' });
    expect(o.status).toBe('pending_payment');
    expect(o.placedAt).toBeNull();
    const events = await db().outboxEvent.findMany({ where: { aggregateId: o.id } });
    expect(events.map((e) => e.event)).toEqual(['order.updated']);
  });

  it('rejects carts that cannot be checked out', async () => {
    const c = await fx.customer();
    const cart = await cartWith(c, s, item.id);
    const far = await fx.farAddress(c.userId);
    const res = await placeReq(c, { cartId: cart.id, addressId: far.id }).expect(422);
    expect(res.body.error.code).toBe('OUT_OF_DELIVERY_ZONE');
    await placeReq(c, { cartId: cart.id, paymentMethod: 'wallet' }).expect(400);
    await placeReq(c, { cartId: cart.id, type: 'group' }).expect(400);
    // Someone else's cart looks missing.
    const other = await fx.customer();
    await placeReq(other, { cartId: cart.id }).expect(404);
  });

  it('enforces the merchant customer block', async () => {
    const c = await fx.customer();
    await place(c, s, item.id);
    const stranger = await fx.customer();
    await api()
      .put(`${s.base}/customer-blocks`)
      .set(bearer(s.owner))
      .send({ userId: stranger.userId })
      .expect(404);
    await api()
      .put(`${s.base}/customer-blocks`)
      .set(bearer(s.kitchen))
      .send({ userId: c.userId })
      .expect(403);
    await api()
      .put(`${s.base}/customer-blocks`)
      .set(bearer(s.owner))
      .send({ userId: c.userId, reason: 'Repeated no-shows' })
      .expect(200);
    const list = await api().get(`${s.base}/customer-blocks`).set(bearer(s.owner)).expect(200);
    expect(list.body.items).toMatchObject([{ userId: c.userId, reason: 'Repeated no-shows' }]);

    const cart = await cartWith(c, s, item.id);
    await placeReq(c, { cartId: cart.id }).expect(403);
    await api().delete(`${s.base}/customer-blocks/${c.userId}`).set(bearer(s.owner)).expect(204);
    await placeReq(c, { cartId: cart.id }).expect(201);
  });

  it('applies scheduling and advance-order rules', async () => {
    const catering = await fx.store({ advanceOrderHours: 24 });
    const tray = await fx.product(catering.merchantId, { price: 50_000 });
    const c = await fx.customer();
    const cart = await cartWith(c, catering, tray.id);
    const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

    await placeReq(c, { cartId: cart.id }).expect(400);
    await placeReq(c, { cartId: cart.id, type: 'scheduled', scheduledFor: inHours(2) }).expect(400);
    await placeReq(c, { cartId: cart.id, type: 'scheduled', scheduledFor: inHours(80) }).expect(
      400,
    );
    const when = inHours(30);
    const o = (
      await placeReq(c, { cartId: cart.id, type: 'scheduled', scheduledFor: when }).expect(201)
    ).body as Order;
    expect(o).toMatchObject({
      type: 'scheduled',
      status: 'placed',
      scheduledFor: when,
      etaAt: when,
    });
  });

  it('stores gift details', async () => {
    const c = await fx.customer();
    const gift = {
      recipientName: 'Maria',
      recipientPhone: '+639171112222',
      message: 'Happy birthday!',
      hidePrices: true,
    };
    const o = await place(c, s, item.id, 1, { type: 'gift', gift });
    expect(o).toMatchObject({ type: 'gift', gift });
  });

  it('auto-accepts for stores that opted in', async () => {
    const auto = await fx.store({ autoAccept: true });
    const p = await fx.product(auto.merchantId);
    const c = await fx.customer();
    const o = await place(c, auto, p.id, 3);
    expect(o).toMatchObject({ status: 'confirmed', version: 1, prepTimeMinutes: 15 });
    const history = await db().orderStatusHistory.findMany({
      where: { orderId: o.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((h) => [h.toStatus, h.actor])).toEqual([
      ['placed', 'customer'],
      ['confirmed', 'system'],
    ]);
  });

  it('checks out a group cart as a group order', async () => {
    const host = await fx.customer();
    const friend = await fx.customer();
    const g = (
      await api()
        .post('/v1/group-carts')
        .set(bearer(host.token))
        .send({ merchantId: s.merchantId, displayName: 'Host' })
        .expect(200)
    ).body as GroupCart;
    await api()
      .post('/v1/group-carts/join')
      .set(bearer(friend.token))
      .send({ code: g.code, displayName: 'Friend' })
      .expect(200);
    await api()
      .post(`/v1/group-carts/${g.id}/items`)
      .set(bearer(friend.token))
      .send({ productId: item.id, quantity: 1 })
      .expect(200);
    await cartWith(host, s, item.id);
    await placeReq(friend, { cartId: g.cart.id }).expect(404);
    const o = (await placeReq(host, { cartId: g.cart.id }).expect(201)).body as Order;
    expect(o).toMatchObject({ type: 'group', groupId: g.id });
    expect(o.items.reduce((n, i) => n + i.quantity, 0)).toBe(2);
    const group = await db().groupCart.findUniqueOrThrow({ where: { id: g.id } });
    expect(group.status).toBe('ordered');
  });
});

describe('order lifecycle', () => {
  let s: Store;
  let rider: Rider;
  let item: Awaited<ReturnType<typeof fx.product>>;

  beforeAll(async () => {
    s = await fx.store();
    rider = await fx.rider();
    item = await fx.product(s.merchantId, { price: 10_000, stock: 50 });
  });

  it('runs the full happy path placed -> delivered', async () => {
    const c = await fx.customer();
    let o = await place(c, s, item.id, 2);

    const suggestion = (
      await api().get(`${s.base}/orders/${o.id}/prep-suggestion`).set(bearer(s.owner)).expect(200)
    ).body as PrepSuggestion;
    expect(suggestion).toEqual({ minutes: 15, basedOnHistory: false });

    await merchantPost(s, o.id, 'accept', { version: o.version + 1 }).expect(409);
    await merchantPost(s, o.id, 'accept', { version: o.version }, s.kitchen).expect(403);
    let m = (
      await merchantPost(s, o.id, 'accept', { version: o.version, prepTimeMinutes: 25 }).expect(200)
    ).body as MerchantOrder;
    expect(m).toMatchObject({ status: 'confirmed', prepTimeMinutes: 25, version: 1 });
    expect(m.commissionCentavos).toBeGreaterThan(0);

    await merchantPost(s, o.id, 'transition', { to: 'preparing', version: m.version }).expect(200);
    m = (
      await merchantPost(s, o.id, 'prep', { prepUpdate: 'being_packed', etaMinutes: 20 }).expect(
        200,
      )
    ).body as MerchantOrder;
    expect(m.prepUpdate).toBe('being_packed');
    await merchantPost(s, o.id, 'transition', { to: 'ready', version: m.version }).expect(200);

    let cur: { id: string; version: number } = await assign(o.id, rider.riderId);
    for (const to of [
      'rider_at_merchant',
      'picked_up',
      'on_the_way',
      'rider_nearby',
      'delivered',
    ]) {
      o = (await riderMove(rider, cur, to).expect(200)).body as Order;
      expect(o.status).toBe(to);
      cur = o;
    }
    expect(o.paymentStatus).toBe('paid');
    expect(o.deliveredAt).not.toBeNull();

    const mine = (await api().get(`/v1/orders/${o.id}`).set(bearer(c.token)).expect(200))
      .body as Order;
    expect(mine).toMatchObject({ status: 'delivered', riderId: rider.riderId });
    const history = await db().orderStatusHistory.findMany({
      where: { orderId: o.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((h) => h.toStatus)).toEqual([
      'placed',
      'confirmed',
      'preparing',
      'ready',
      'rider_assigned',
      'rider_at_merchant',
      'picked_up',
      'on_the_way',
      'rider_nearby',
      'delivered',
    ]);
    // One order.updated per status change, each with its own version.
    const updates = await db().outboxEvent.findMany({
      where: { aggregateId: o.id, event: 'order.updated' },
    });
    expect(new Set(updates.map((e) => e.version)).size).toBe(history.length);
    const delivered = must(
      updates.find((e) => (e.payload as { data: { status: string } }).data.status === 'delivered'),
    );
    expect(delivered.rooms).toContain(`rider:${rider.riderId}`);
    expect(delivered.push).toMatchObject({
      userIds: [c.userId],
      titleKey: 'notifications:orderDelivered.title',
    });

    const listed = await api().get('/v1/orders?status=delivered').set(bearer(c.token)).expect(200);
    expect(listed.body.items.map((x: Order) => x.id)).toEqual([o.id]);
    const merchantList = await api()
      .get(`${s.base}/orders?status=delivered`)
      .set(bearer(s.owner))
      .expect(200);
    expect(merchantList.body.items.map((x: Order) => x.id)).toContain(o.id);
  });

  it('rejects transitions the state machine does not allow', async () => {
    const c = await fx.customer();
    const o = await place(c, s, item.id);
    const skip = await merchantPost(s, o.id, 'transition', {
      to: 'ready',
      version: o.version,
    }).expect(409);
    expect(skip.body.error.code).toBe('INVALID_TRANSITION');
    // Merchants can't play the rider or the system.
    await merchantPost(s, o.id, 'transition', { to: 'picked_up', version: o.version }).expect(409);
    await merchantPost(s, o.id, 'transition', { to: 'confirmed', version: o.version }).expect(400);
    // A rider who isn't assigned can't see the order.
    await riderMove(rider, o, 'picked_up').expect(404);

    let m = (await merchantPost(s, o.id, 'accept', { version: o.version }).expect(200))
      .body as MerchantOrder;
    m = (
      await merchantPost(s, o.id, 'transition', { to: 'preparing', version: m.version }).expect(200)
    ).body as MerchantOrder;
    m = (await merchantPost(s, o.id, 'transition', { to: 'ready', version: m.version }).expect(200))
      .body as MerchantOrder;
    // Customers can't cancel once the food is ready; merchants can't "reject" an accepted order.
    const late = await api()
      .post(`/v1/orders/${o.id}/cancel`)
      .set(bearer(c.token))
      .send({ reason: 'Changed my mind', version: m.version })
      .expect(409);
    expect(late.body.error.code).toBe('INVALID_TRANSITION');
    await merchantPost(s, o.id, 'reject', { reason: 'Busy', version: m.version }).expect(409);
    // Rider steps out of order.
    const assigned = await assign(o.id, rider.riderId);
    await riderMove(rider, assigned, 'delivered').expect(409);
  });

  it('lets exactly one of two concurrent transitions win (version check)', async () => {
    const c = await fx.customer();
    const o = await place(c, s, item.id);
    const results = await Promise.all([
      merchantPost(s, o.id, 'accept', { version: o.version }),
      api()
        .post(`/v1/orders/${o.id}/cancel`)
        .set(bearer(c.token))
        .send({ reason: 'Too slow', version: o.version }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(must(results.find((r) => r.status === 409)).body.error.code).toBe('CONFLICT');
    const row = await db().order.findUniqueOrThrow({ where: { id: o.id } });
    expect(row.version).toBe(1);
    expect(await db().orderStatusHistory.count({ where: { orderId: o.id } })).toBe(2);

    const race = await place(c, s, item.id);
    const twice = await Promise.all([
      merchantPost(s, race.id, 'accept', { version: race.version }),
      merchantPost(s, race.id, 'accept', { version: race.version }),
    ]);
    expect(twice.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('merchant reject frees stock and tells the customer why', async () => {
    const c = await fx.customer();
    const before = await stockOf(item.id);
    const o = await place(c, s, item.id, 3);
    expect(await stockOf(item.id)).toBe(before - 3);
    const m = (
      await merchantPost(s, o.id, 'reject', { reason: 'Out of gas', version: o.version }).expect(
        200,
      )
    ).body as MerchantOrder;
    expect(m).toMatchObject({ status: 'cancelled', cancelReason: 'Out of gas' });
    expect(await stockOf(item.id)).toBe(before);
    const ev = await db().outboxEvent.findFirstOrThrow({
      where: { aggregateId: o.id, event: 'order.updated', version: m.version },
    });
    expect(ev.push).toMatchObject({
      userIds: [c.userId],
      titleKey: 'notifications:orderCancelled.title',
    });
  });
});

describe('customer cancellation', () => {
  let s: Store;
  let item: Awaited<ReturnType<typeof fx.product>>;

  beforeAll(async () => {
    s = await fx.store();
    item = await fx.product(s.merchantId, { price: 10_000, stock: 20 });
  });

  const cancel = (c: Customer, o: { id: string; version: number }) =>
    api()
      .post(`/v1/orders/${o.id}/cancel`)
      .set(bearer(c.token))
      .send({ reason: 'Changed my mind', version: o.version });

  it('is free before preparation and refunds voucher, points and stock', async () => {
    const c = await fx.customer();
    await db().pointsAccount.create({ data: { userId: c.userId, balance: 100 } });
    const code = `CX${randomUUID().slice(0, 6).toUpperCase()}`;
    const voucher = await db().voucher.create({
      data: {
        code,
        title: 'Less 50',
        discountType: 'fixed',
        amountCentavos: 5_000n,
        funding: 'platform',
        startsAt: new Date(Date.now() - 86_400_000),
        endsAt: new Date(Date.now() + 86_400_000),
      },
    });
    const cart = await cartWith(c, s, item.id, 2);
    await api().put(`/v1/carts/${cart.id}/voucher`).set(bearer(c.token)).send({ code }).expect(200);
    const before = await stockOf(item.id);
    const o = (await placeReq(c, { cartId: cart.id, usePoints: 20 }).expect(201)).body as Order;
    expect(o.voucherCode).toBe(code);
    expect(o.pricing).toMatchObject({ pointsRedeemed: 20, pointsValueCentavos: 2_000 });
    expect((await db().voucher.findUniqueOrThrow({ where: { id: voucher.id } })).usedCount).toBe(1);
    expect(
      (await db().pointsAccount.findUniqueOrThrow({ where: { userId: c.userId } })).balance,
    ).toBe(80);

    const done = (await cancel(c, o).expect(200)).body as Order;
    expect(done).toMatchObject({ status: 'cancelled', cancelReason: 'Changed my mind' });
    expect(await stockOf(item.id)).toBe(before);
    expect((await db().voucher.findUniqueOrThrow({ where: { id: voucher.id } })).usedCount).toBe(0);
    expect(await db().voucherRedemption.count({ where: { orderId: o.id } })).toBe(0);
    expect(
      (await db().pointsAccount.findUniqueOrThrow({ where: { userId: c.userId } })).balance,
    ).toBe(100);
    const row = await db().order.findUniqueOrThrow({ where: { id: o.id } });
    expect(row.cancellationCompensationCentavos).toBe(0n);
    expect(row.cancelledBy).toBe('customer');
  });

  it('compensates the merchant (Cancellation Protection) once preparation started', async () => {
    const c = await fx.customer();
    const o = await place(c, s, item.id, 2);
    let m = (await merchantPost(s, o.id, 'accept', { version: o.version }).expect(200))
      .body as MerchantOrder;
    m = (
      await merchantPost(s, o.id, 'transition', { to: 'preparing', version: m.version }).expect(200)
    ).body as MerchantOrder;
    await cancel(c, m).expect(200);
    const view = (await api().get(`${s.base}/orders/${o.id}`).set(bearer(s.owner)).expect(200))
      .body as MerchantOrder;
    // 50% of the ₱200 item subtotal.
    expect(view.cancellationCompensationCentavos).toBe(10_000);
    const ev = await db().outboxEvent.findMany({
      where: { aggregateId: o.id, event: 'merchant.order_cancelled' },
    });
    expect(ev).toHaveLength(1);
  });

  it('allows confirmed orders to be cancelled without compensation', async () => {
    const c = await fx.customer();
    const o = await place(c, s, item.id);
    const m = (await merchantPost(s, o.id, 'accept', { version: o.version }).expect(200))
      .body as MerchantOrder;
    await cancel(c, m).expect(200);
    const row = await db().order.findUniqueOrThrow({ where: { id: o.id } });
    expect(row.cancellationCompensationCentavos).toBe(0n);
  });
});

describe('replacements', () => {
  it('swaps or drops out-of-stock items with the customer’s consent', async () => {
    const s = await fx.store();
    const a = await fx.product(s.merchantId, { name: 'Pancit', price: 10_000 });
    const b = await fx.product(s.merchantId, { name: 'Lumpia', price: 5_000 });
    const sub = await fx.product(s.merchantId, { name: 'Bihon', price: 12_000, stock: 5 });
    const c = await fx.customer();
    await cartWith(c, s, a.id, 2);
    const cart = await cartWith(c, s, b.id, 1);
    const o = (await placeReq(c, { cartId: cart.id }).expect(201)).body as Order;
    const lineA = must(o.items.find((i) => i.productId === a.id));
    const lineB = must(o.items.find((i) => i.productId === b.id));

    const proposed = (
      await api()
        .post(`${s.base}/orders/${o.id}/replacements`)
        .set(bearer(s.owner))
        .send({ orderItemId: lineA.id, productId: sub.id })
        .expect(201)
    ).body as MerchantOrder;
    const r = must(proposed.replacements[0]);
    expect(r).toMatchObject({
      name: 'Bihon',
      unitPriceCentavos: 12_000,
      quantity: 2,
      status: 'proposed',
    });
    await api()
      .post(`${s.base}/orders/${o.id}/replacements`)
      .set(bearer(s.owner))
      .send({ orderItemId: lineA.id, productId: sub.id })
      .expect(409);

    const accepted = (
      await api()
        .post(`/v1/orders/${o.id}/replacements/${r.id}/respond`)
        .set(bearer(c.token))
        .send({ accept: true })
        .expect(200)
    ).body as Order;
    // +₱40: two ₱120 Bihon replace two ₱100 Pancit.
    expect(accepted.pricing.subtotalCentavos).toBe(o.pricing.subtotalCentavos + 4_000);
    expect(accepted.pricing.totalCentavos).toBe(o.pricing.totalCentavos + 4_000);
    expect(
      accepted.items
        .filter((i) => !i.removedAt)
        .map((i) => i.name)
        .sort(),
    ).toEqual(['Bihon', 'Lumpia']);
    expect(await stockOf(sub.id)).toBe(3);
    await api()
      .post(`/v1/orders/${o.id}/replacements/${r.id}/respond`)
      .set(bearer(c.token))
      .send({ accept: true })
      .expect(409);

    const second = (
      await api()
        .post(`${s.base}/orders/${o.id}/replacements`)
        .set(bearer(s.owner))
        .send({ orderItemId: lineB.id, productId: sub.id, quantity: 1 })
        .expect(201)
    ).body as MerchantOrder;
    const r2 = must(second.replacements.find((x) => x.status === 'proposed'));
    const rejected = (
      await api()
        .post(`/v1/orders/${o.id}/replacements/${r2.id}/respond`)
        .set(bearer(c.token))
        .send({ accept: false })
        .expect(200)
    ).body as Order;
    expect(rejected.pricing.subtotalCentavos).toBe(accepted.pricing.subtotalCentavos - 5_000);
    expect(rejected.items.filter((i) => !i.removedAt).map((i) => i.name)).toEqual(['Bihon']);
  });
});

describe('order chat', () => {
  it('keeps store and rider conversations separate', async () => {
    const s = await fx.store();
    const p = await fx.product(s.merchantId);
    const c = await fx.customer();
    const rider = await fx.rider();
    const o = await place(c, s, p.id);
    const chat = `/v1/orders/${o.id}/chat`;

    const sent = (
      await api()
        .post(chat)
        .set(bearer(c.token))
        .send({ channel: 'merchant', body: 'Extra sauce please' })
        .expect(201)
    ).body as OrderChatMessage;
    expect(sent).toMatchObject({ channel: 'merchant', senderRole: 'customer' });
    await api().post(chat).set(bearer(c.token)).send({ channel: 'rider', body: 'Hi' }).expect(409);
    await api()
      .post(chat)
      .set(bearer(s.owner))
      .send({ channel: 'merchant', body: 'Sure!' })
      .expect(201);
    // Kitchen staff lack orders.manage; strangers and unassigned riders see nothing.
    await api().get(`${chat}?channel=merchant`).set(bearer(s.kitchen)).expect(404);
    await api()
      .get(`${chat}?channel=merchant`)
      .set(bearer((await fx.customer()).token))
      .expect(404);
    await api().get(`${chat}?channel=rider`).set(bearer(rider.token)).expect(404);

    const thread = await api().get(`${chat}?channel=merchant`).set(bearer(s.owner)).expect(200);
    expect(thread.body.items.map((m: OrderChatMessage) => m.body)).toEqual([
      'Sure!',
      'Extra sauce please',
    ]);

    const m = (await merchantPost(s, o.id, 'accept', { version: o.version }).expect(200))
      .body as MerchantOrder;
    await assign(m.id, rider.riderId);
    await api()
      .post(chat)
      .set(bearer(rider.token))
      .send({ channel: 'rider', body: 'On my way' })
      .expect(201);
    await api().get(`${chat}?channel=merchant`).set(bearer(rider.token)).expect(403);
    await api().get(`${chat}?channel=rider`).set(bearer(s.owner)).expect(403);
    const riderThread = await api().get(`${chat}?channel=rider`).set(bearer(c.token)).expect(200);
    expect(riderThread.body.items).toHaveLength(1);

    const ev = await db().outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: o.id,
        event: 'order.chat_message',
        rooms: { has: `rider:${rider.riderId}` },
      },
    });
    expect(ev.rooms).not.toContain(`merchant:${s.merchantId}`);
    expect(ev.push).toMatchObject({ userIds: [c.userId] });
  });
});
