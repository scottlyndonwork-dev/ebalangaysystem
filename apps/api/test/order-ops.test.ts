import { randomUUID } from 'node:crypto';
import { type Cart, type Order, SocketEvent } from '@ebalangay/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RELEASE_BATCH_SIZE, releaseScheduledOrders } from '../src/modules/orders/release.js';
import { SWEEP_BATCH_SIZE, sweepStaleOrders } from '../src/modules/orders/sweeper.js';
import { transitionOrder } from '../src/modules/orders/transitions.js';
import { runSubscriptions, SUBSCRIPTION_BATCH_SIZE } from '../src/modules/subscriptions/run.js';
import { bearer, fixtures, must } from './fixtures.js';
import { buildTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
let ctx: Ctx;
const api = () => request(ctx.app.server);
const db = () => ctx.app.db;
const fx = fixtures(() => ctx);

type Store = Awaited<ReturnType<typeof fx.store>>;
type Customer = Awaited<ReturnType<typeof fx.customer>>;

const MIN = 60_000;
const at = (minutes: number) => new Date(Date.now() + minutes * MIN);

async function place(
  c: Customer,
  s: Store,
  productId: string,
  body: Record<string, unknown> = {},
  quantity = 1,
): Promise<Order> {
  const cart = await api()
    .post('/v1/carts/items')
    .set(bearer(c.token))
    .send({ merchantId: s.merchantId, productId, quantity })
    .expect(200);
  const res = await api()
    .post('/v1/orders')
    .set(bearer(c.token))
    .set('Idempotency-Key', randomUUID())
    .send({ cartId: (cart.body as Cart).id, addressId: c.addressId, paymentMethod: 'cod', ...body })
    .expect(201);
  return res.body as Order;
}

// Jobs work in batches; earlier test files may leave stale rows ahead of ours.
async function drain<T>(run: () => Promise<T>, size: (r: T) => number, batch: number) {
  const results: T[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await run();
    results.push(r);
    if (size(r) < batch) break;
  }
  return results;
}
const release = () =>
  drain(
    () => releaseScheduledOrders(db()),
    (r) => r.released,
    RELEASE_BATCH_SIZE,
  );
const sweep = () =>
  drain(
    () => sweepStaleOrders({ db: db(), redis: ctx.app.redis }),
    (r) => Math.max(r.paymentTimeouts, r.merchantTimeouts, r.noRiderAlerts),
    SWEEP_BATCH_SIZE,
  );
const runSubs = () =>
  drain(
    () => runSubscriptions({ db: db() }),
    (r) => r.placed + r.skipped,
    SUBSCRIPTION_BATCH_SIZE,
  );

const outboxFor = (aggregateId: string, event: string) =>
  db().outboxEvent.findMany({ where: { aggregateId, event }, orderBy: { createdAt: 'asc' } });
const pushOf = (e: { push: unknown }) => e.push as { titleKey: string; userIds: string[] };

let store: Store;
let customer: Customer;
let productId: string;

beforeAll(async () => {
  ctx = await buildTestApp();
  await fx.zone();
  store = await fx.store();
  customer = await fx.customer();
  productId = (await fx.product(store.merchantId, { price: 20_000 })).id;
});
afterAll(async () => {
  await ctx.close();
});

describe('scheduled order release', () => {
  it('releases once when due and reminds the merchant to accept', async () => {
    const o = await place(customer, store, productId, { scheduledFor: at(180).toISOString() });
    await release();
    expect(must(await db().order.findUnique({ where: { id: o.id } })).releasedAt).toBeNull();

    // prep 15 + buffer 10: due once scheduledFor is under 25 minutes away.
    await db().order.update({ where: { id: o.id }, data: { scheduledFor: at(20) } });
    await release();
    await release();
    const row = must(await db().order.findUnique({ where: { id: o.id } }));
    expect(row.releasedAt).not.toBeNull();
    expect(row.status).toBe('placed');
    const events = await outboxFor(o.id, SocketEvent.MERCHANT_ORDER_RELEASED);
    expect(events).toHaveLength(1);
    const e = must(events[0]);
    expect(e.rooms).toEqual([`merchant:${store.merchantId}`]);
    expect(pushOf(e).titleKey).toBe('notifications:scheduledUnconfirmed.title');
    expect(pushOf(e).userIds).toContain(store.ownerId);
  });

  it('tells an accepting merchant to start preparing', async () => {
    const o = await place(customer, store, productId, { scheduledFor: at(180).toISOString() });
    await db().$transaction((tx) =>
      transitionOrder(tx, {
        orderId: o.id,
        to: 'confirmed',
        actor: 'merchant',
        actorUserId: store.ownerId,
        data: { prepTimeMinutes: 40 },
      }),
    );
    // Order's own prep time (40) wins over the store default: 45 min before is due.
    await db().order.update({ where: { id: o.id }, data: { scheduledFor: at(45) } });
    await release();
    const [e] = await outboxFor(o.id, SocketEvent.MERCHANT_ORDER_RELEASED);
    expect(pushOf(must(e)).titleKey).toBe('notifications:scheduledRelease.title');
  });
});

describe('stale order sweeper', () => {
  it('cancels unaccepted ASAP orders after the timeout and restores stock', async () => {
    const stocked = await fx.product(store.merchantId, { stock: 5 });
    const stale = await place(customer, store, stocked.id, {}, 2);
    const fresh = await place(customer, store, productId);
    await db().order.update({ where: { id: stale.id }, data: { placedAt: at(-16) } });
    await sweep();

    const s = must(await db().order.findUnique({ where: { id: stale.id } }));
    expect(s.status).toBe('cancelled');
    expect(s.cancelledBy).toBe('system');
    expect(s.cancelReason).toBe('merchant_timeout');
    const level = must(await db().inventoryLevel.findFirst({ where: { productId: stocked.id } }));
    expect(level.quantity).toBe(5);
    expect(must(await db().order.findUnique({ where: { id: fresh.id } })).status).toBe('placed');
  });

  it('cancels scheduled orders still unaccepted after the release grace', async () => {
    const o = await place(customer, store, productId, { scheduledFor: at(180).toISOString() });
    await db().order.update({ where: { id: o.id }, data: { releasedAt: at(-5) } });
    await sweep();
    expect(must(await db().order.findUnique({ where: { id: o.id } })).status).toBe('placed');
    await db().order.update({ where: { id: o.id }, data: { releasedAt: at(-11) } });
    await sweep();
    expect(must(await db().order.findUnique({ where: { id: o.id } })).status).toBe('cancelled');
  });

  it('cancels unpaid online orders after the payment timeout', async () => {
    const o = await place(customer, store, productId, { paymentMethod: 'gcash' });
    expect(o.status).toBe('pending_payment');
    await db().order.update({ where: { id: o.id }, data: { createdAt: at(-31) } });
    await sweep();
    const row = must(await db().order.findUnique({ where: { id: o.id } }));
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('payment_timeout');
  });

  it('alerts admins once about accepted orders without a rider', async () => {
    const o = await place(customer, store, productId);
    await db().$transaction((tx) =>
      transitionOrder(tx, {
        orderId: o.id,
        to: 'confirmed',
        actor: 'merchant',
        actorUserId: store.ownerId,
      }),
    );
    await sweep();
    expect(await outboxFor(o.id, SocketEvent.ADMIN_ORDER_ALERT)).toHaveLength(0);
    await db().order.update({ where: { id: o.id }, data: { confirmedAt: at(-31) } });
    await sweep();
    await sweep();
    const alerts = await outboxFor(o.id, SocketEvent.ADMIN_ORDER_ALERT);
    expect(alerts).toHaveLength(1);
    expect(must(alerts[0]).rooms).toEqual(['admin']);
    expect(must(await db().order.findUnique({ where: { id: o.id } })).status).toBe('confirmed');
  });
});

describe('subscription orders', () => {
  const subscribe = (
    c: Customer,
    o: { nextRunAt: Date; paymentMethod?: 'cod' | 'gcash'; productId?: string; qty?: number },
  ) =>
    db().subscriptionOrder.create({
      data: {
        userId: c.userId,
        merchantId: store.merchantId,
        addressId: c.addressId,
        items: [{ productId: o.productId ?? productId, quantity: o.qty ?? 2 }],
        paymentMethod: o.paymentMethod ?? 'cod',
        cadence: 'weekly',
        nextRunAt: o.nextRunAt,
      },
    });

  it('places the next run as a scheduled subscription order, once', async () => {
    const c = await fx.customer();
    const runAt = at(60);
    const sub = await subscribe(c, { nextRunAt: runAt });
    await runSubs();
    await runSubs();

    const orders = await db().order.findMany({ where: { subscriptionOrderId: sub.id } });
    expect(orders).toHaveLength(1);
    const o = must(orders[0]);
    expect(o.type).toBe('subscription');
    expect(o.status).toBe('placed');
    expect(o.customerId).toBe(c.userId);
    expect(o.scheduledFor?.getTime()).toBe(runAt.getTime());
    expect(o.subtotalCentavos).toBe(40_000n);
    const after = must(await db().subscriptionOrder.findUnique({ where: { id: sub.id } }));
    expect(after.nextRunAt.getTime()).toBe(runAt.getTime() + 7 * 24 * 60 * MIN);

    const [e] = await outboxFor(sub.id, SocketEvent.SUBSCRIPTION_RUN);
    expect(must(e).rooms).toEqual([`user:${c.userId}`]);
    expect(pushOf(must(e)).titleKey).toBe('notifications:subscriptionPlaced.title');
  });

  it('leaves runs beyond the lead time alone', async () => {
    const c = await fx.customer();
    const sub = await subscribe(c, { nextRunAt: at(180) });
    await runSubs();
    expect(await db().order.count({ where: { subscriptionOrderId: sub.id } })).toBe(0);
  });

  it.each([
    ['payment_method_unavailable', { paymentMethod: 'gcash' as const }],
    ['missed', { nextRunAt: at(-60) }],
  ])('skips a run (%s) and moves to the next one', async (reason, o) => {
    const c = await fx.customer();
    const sub = await subscribe(c, { nextRunAt: at(60), ...o });
    await runSubs();
    expect(await db().order.count({ where: { subscriptionOrderId: sub.id } })).toBe(0);
    const after = must(await db().subscriptionOrder.findUnique({ where: { id: sub.id } }));
    expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(after.nextRunAt.getTime()).toBeGreaterThan(sub.nextRunAt.getTime());
    const [e] = await outboxFor(sub.id, SocketEvent.SUBSCRIPTION_RUN);
    const payload = must(e).payload as { data: { skippedReason: string } };
    expect(payload.data.skippedReason).toBe(reason);
    expect(pushOf(must(e)).titleKey).toBe('notifications:subscriptionSkipped.title');
  });

  it('skips when an item is out of stock', async () => {
    const c = await fx.customer();
    const scarce = await fx.product(store.merchantId, { stock: 1 });
    const sub = await subscribe(c, { nextRunAt: at(60), productId: scarce.id, qty: 2 });
    await runSubs();
    expect(await db().order.count({ where: { subscriptionOrderId: sub.id } })).toBe(0);
    const [e] = await outboxFor(sub.id, SocketEvent.SUBSCRIPTION_RUN);
    const payload = must(e).payload as { data: { skippedReason: string } };
    expect(payload.data.skippedReason).toBe('item_unavailable');
  });
});
