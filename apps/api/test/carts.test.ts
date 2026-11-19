import { randomUUID } from 'node:crypto';
import type { Cart, CheckoutQuote, GroupCart } from '@ebalangay/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, fixtures, must } from './fixtures.js';
import { buildTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
let ctx: Ctx;
const api = () => request(ctx.app.server);
const fx = fixtures(() => ctx);

type Store = Awaited<ReturnType<typeof fx.store>>;
type Customer = Awaited<ReturnType<typeof fx.customer>>;

const addItem = (c: Customer, body: Record<string, unknown>, status = 200) =>
  api().post('/v1/carts/items').set(bearer(c.token)).send(body).expect(status);

const quote = async (c: Customer, cartId: string, qs = '') =>
  (await api().get(`/v1/carts/${cartId}/quote${qs}`).set(bearer(c.token)).expect(200))
    .body as CheckoutQuote;

beforeAll(async () => {
  ctx = await buildTestApp({ env: { RATE_LIMIT_ENABLED: 'false' } });
  await fx.zone();
});
afterAll(async () => {
  await ctx.close();
});

describe('cart', () => {
  let s: Store;
  let c: Customer;
  let burger: Awaited<ReturnType<typeof fx.product>>;

  beforeAll(async () => {
    s = await fx.store();
    c = await fx.customer();
    burger = await fx.product(s.merchantId, {
      price: 12_000,
      modifiers: {
        min: 0,
        max: 2,
        options: [
          { name: 'Cheese', delta: 2_000 },
          { name: 'Egg', delta: 1_500 },
        ],
      },
    });
  });

  it('adds items, merges identical lines and prices on the server', async () => {
    const cheese = must(
      must(burger.modifierGroups[0]).modifiers.find((m) => m.name === 'Cheese'),
    ).id;
    const body = {
      merchantId: s.merchantId,
      productId: burger.id,
      quantity: 1,
      modifierOptionIds: [cheese],
    };
    await addItem(c, body);
    const cart = (await addItem(c, { ...body, quantity: 2 })).body as Cart;
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]).toMatchObject({
      quantity: 3,
      unitPriceCentavos: 14_000,
      lineTotalCentavos: 42_000,
      modifierNames: ['Cheese'],
      isAvailable: true,
    });
    expect(cart.pricing.subtotalCentavos).toBe(42_000);
    // Default address is 1 km away: delivery is priced.
    expect(cart.pricing.deliveryFeeCentavos).toBeGreaterThan(0);
    expect(cart.groupCartId).toBeNull();
  });

  it('ignores client prices and rejects bad selections', async () => {
    const res = await addItem(c, {
      merchantId: s.merchantId,
      productId: burger.id,
      quantity: 1,
      unitPriceCentavos: 1,
    });
    expect((res.body as Cart).items[0]?.unitPriceCentavos).toBe(14_000);

    const tooMany = must(burger.modifierGroups[0]).modifiers.map((m) => m.id);
    const sized = await fx.product(s.merchantId, { variants: [{ name: 'Small', price: 5_000 }] });
    await addItem(c, { merchantId: s.merchantId, productId: sized.id, quantity: 1 }, 400);
    await addItem(
      c,
      { merchantId: s.merchantId, productId: sized.id, variantId: randomUUID(), quantity: 1 },
      400,
    );
    await addItem(
      c,
      {
        merchantId: s.merchantId,
        productId: burger.id,
        quantity: 1,
        modifierOptionIds: [randomUUID()],
      },
      400,
    );
    // Max 2 add-ons: 2 is fine, a third id from another product is invalid.
    await addItem(c, {
      merchantId: s.merchantId,
      productId: burger.id,
      quantity: 1,
      modifierOptionIds: tooMany,
    });
    await addItem(c, { merchantId: s.merchantId, productId: randomUUID(), quantity: 1 }, 404);
  });

  it('enforces stock and flags items that become unavailable', async () => {
    const other = await fx.customer();
    const limited = await fx.product(s.merchantId, { price: 5_000, stock: 2 });
    await addItem(other, { merchantId: s.merchantId, productId: limited.id, quantity: 3 }, 422);
    const cart = (
      await addItem(other, { merchantId: s.merchantId, productId: limited.id, quantity: 2 })
    ).body as Cart;

    await ctx.app.db.product.update({ where: { id: limited.id }, data: { isAvailable: false } });
    const q = await quote(other, cart.id);
    expect(q.cart.items[0]?.isAvailable).toBe(false);
    expect(q.cart.pricing.subtotalCentavos).toBe(0);
    expect(q.canCheckout).toBe(false);
    expect(q.issues).toContainEqual({ code: 'ITEM_UNAVAILABLE', blocking: true });
  });

  it('is private to its owner', async () => {
    const cart = (await addItem(c, { merchantId: s.merchantId, productId: burger.id, quantity: 1 }))
      .body as Cart;
    const stranger = await fx.customer();
    await api().get(`/v1/carts/${cart.id}`).set(bearer(stranger.token)).expect(404);
    await api()
      .delete(`/v1/carts/${cart.id}/items/${must(cart.items[0]).id}`)
      .set(bearer(stranger.token))
      .expect(404);
    await api().get(`/v1/carts/${cart.id}`).expect(401);
  });

  it('lists, edits and deletes', async () => {
    const buyer = await fx.customer();
    const cart = (
      await addItem(buyer, { merchantId: s.merchantId, productId: burger.id, quantity: 1 })
    ).body as Cart;
    const itemId = must(cart.items[0]).id;
    const edited = (
      await api()
        .patch(`/v1/carts/${cart.id}/items/${itemId}`)
        .set(bearer(buyer.token))
        .send({ quantity: 5, notes: 'no onions' })
        .expect(200)
    ).body as Cart;
    expect(edited.items[0]).toMatchObject({ quantity: 5, notes: 'no onions' });

    const list = (await api().get('/v1/carts').set(bearer(buyer.token)).expect(200)).body as {
      items: Cart[];
    };
    expect(list.items.map((x) => x.id)).toEqual([cart.id]);

    const emptied = (
      await api()
        .delete(`/v1/carts/${cart.id}/items/${itemId}`)
        .set(bearer(buyer.token))
        .expect(200)
    ).body as Cart;
    expect(emptied.items).toHaveLength(0);
    await api().delete(`/v1/carts/${cart.id}`).set(bearer(buyer.token)).expect(204);
    await api().get(`/v1/carts/${cart.id}`).set(bearer(buyer.token)).expect(404);
  });
});

describe('vouchers and checkout quote', () => {
  let s: Store;
  let item: Awaited<ReturnType<typeof fx.product>>;

  beforeAll(async () => {
    s = await fx.store({ minOrder: 20_000n });
    item = await fx.product(s.merchantId, { price: 10_000 });
  });

  const voucher = (o: { minSpend?: bigint; merchantId?: string | null } = {}) =>
    ctx.app.db.voucher.create({
      data: {
        code: `T${randomUUID().slice(0, 8).toUpperCase()}`,
        title: 'Test',
        discountType: 'percent',
        percentBps: 1_000,
        funding: 'platform',
        minSpendCentavos: o.minSpend ?? 0n,
        merchantId: o.merchantId ?? null,
        startsAt: new Date(Date.now() - 3_600_000),
        endsAt: new Date(Date.now() + 3_600_000),
      },
    });

  it('applies a valid voucher and reports ineligible ones as warnings', async () => {
    const c = await fx.customer();
    const cart = (await addItem(c, { merchantId: s.merchantId, productId: item.id, quantity: 3 }))
      .body as Cart;
    await api()
      .put(`/v1/carts/${cart.id}/voucher`)
      .set(bearer(c.token))
      .send({ code: 'NOPE-NOPE' })
      .expect(422);

    const v = await voucher();
    const applied = (
      await api()
        .put(`/v1/carts/${cart.id}/voucher`)
        .set(bearer(c.token))
        .send({ code: v.code.toLowerCase() })
        .expect(200)
    ).body as Cart;
    expect(applied.voucherCode).toBe(v.code);
    expect(applied.pricing.discountCentavos).toBe(3_000);

    const big = await voucher({ minSpend: 1_000_000n });
    const warned = (
      await api()
        .put(`/v1/carts/${cart.id}/voucher`)
        .set(bearer(c.token))
        .send({ code: big.code })
        .expect(200)
    ).body as Cart;
    expect(warned.pricing.discountCentavos).toBe(0);
    expect(warned.warnings.map((w) => w.code)).toContain('VOUCHER_MIN_SPEND');

    const removed = (
      await api().delete(`/v1/carts/${cart.id}/voucher`).set(bearer(c.token)).expect(200)
    ).body as Cart;
    expect(removed.voucherCode).toBeNull();
  });

  it('quotes delivery, ETA and blocking issues', async () => {
    const c = await fx.customer(1500);
    const cart = (await addItem(c, { merchantId: s.merchantId, productId: item.id, quantity: 1 }))
      .body as Cart;
    let q = await quote(c, cart.id, '?tipCentavos=2000&roundUpDonation=true');
    expect(q.addressId).toBe(c.addressId);
    expect(q.distanceMeters).toBeGreaterThan(1000);
    expect(q.etaMinutes).toBeGreaterThan(0);
    expect(q.cart.pricing.tipCentavos).toBe(2_000);
    expect(q.cart.pricing.totalCentavos % 1_000).toBe(0);
    expect(q.issues).toContainEqual({ code: 'BELOW_MIN_ORDER', blocking: true });
    expect(q.canCheckout).toBe(false);

    await addItem(c, { merchantId: s.merchantId, productId: item.id, quantity: 1 });
    q = await quote(c, cart.id);
    expect(q.canCheckout).toBe(true);

    const far = await fx.farAddress(c.userId);
    q = await quote(c, cart.id, `?addressId=${far.id}`);
    expect(q.issues).toContainEqual({ code: 'OUT_OF_DELIVERY_ZONE', blocking: true });
    expect(q.cart.pricing.deliveryFeeCentavos).toBe(0);

    const stranger = await fx.customer();
    await api()
      .get(`/v1/carts/${cart.id}/quote?addressId=${stranger.addressId}`)
      .set(bearer(c.token))
      .expect(404);
  });

  it('flags a closed store', async () => {
    const closed = await fx.store({ open: false });
    const p = await fx.product(closed.merchantId);
    const c = await fx.customer();
    const cart = (await addItem(c, { merchantId: closed.merchantId, productId: p.id, quantity: 1 }))
      .body as Cart;
    const q = await quote(c, cart.id);
    expect(q.issues).toContainEqual({ code: 'STORE_CLOSED', blocking: true });
  });

  it('gives verified merchants wholesale prices', async () => {
    const supplier = await fx.store({ businessType: 'supplier' });
    const rice = await fx.product(supplier.merchantId, {
      price: 5_000,
      wholesale: [{ minQty: 10, price: 4_000 }],
    });
    const buyerStore = await fx.store({ verified: true });
    const res = await api()
      .post('/v1/carts/items')
      .set(bearer(buyerStore.ownerAsBuyer))
      .send({ merchantId: supplier.merchantId, productId: rice.id, quantity: 10 })
      .expect(200);
    expect((res.body as Cart).pricing.subtotalCentavos).toBe(40_000);

    const regular = await fx.customer();
    const res2 = await addItem(regular, {
      merchantId: supplier.merchantId,
      productId: rice.id,
      quantity: 10,
    });
    expect((res2.body as Cart).pricing.subtotalCentavos).toBe(50_000);
  });
});

describe('group cart', () => {
  let s: Store;
  let a: Awaited<ReturnType<typeof fx.product>>;
  let b: Awaited<ReturnType<typeof fx.product>>;

  beforeAll(async () => {
    s = await fx.store();
    a = await fx.product(s.merchantId, { price: 10_000 });
    b = await fx.product(s.merchantId, { price: 30_000 });
  });

  it('host invites, members add items, host quotes with a per-member split', async () => {
    const host = await fx.customer();
    const friend = await fx.customer();
    const outsider = await fx.customer();
    // An existing cart becomes the host's share.
    await addItem(host, { merchantId: s.merchantId, productId: a.id, quantity: 1 });

    const created = (
      await api()
        .post('/v1/group-carts')
        .set(bearer(host.token))
        .send({ merchantId: s.merchantId, displayName: 'Host' })
        .expect(200)
    ).body as GroupCart;
    expect(created.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(created.members).toHaveLength(1);
    await api()
      .post('/v1/group-carts')
      .set(bearer(host.token))
      .send({ merchantId: s.merchantId, displayName: 'Host' })
      .expect(409);

    const gid = created.id;
    await api().get(`/v1/group-carts/${gid}`).set(bearer(outsider.token)).expect(404);
    const joined = (
      await api()
        .post('/v1/group-carts/join')
        .set(bearer(friend.token))
        .send({ code: created.code.toLowerCase(), displayName: 'Friend' })
        .expect(200)
    ).body as GroupCart;
    expect(joined.members.map((m) => m.displayName)).toEqual(['Host', 'Friend']);

    const withItem = (
      await api()
        .post(`/v1/group-carts/${gid}/items`)
        .set(bearer(friend.token))
        .send({ productId: b.id, quantity: 1 })
        .expect(200)
    ).body as GroupCart;
    const friendMember = must(withItem.members.find((m) => m.displayName === 'Friend'));
    expect(friendMember).toMatchObject({ itemCount: 1, subtotalCentavos: 30_000 });

    // Friend can't touch the host's line; the host can touch anyone's.
    const hostLine = must(withItem.cart.items.find((i) => i.productId === a.id));
    const friendLine = must(withItem.cart.items.find((i) => i.productId === b.id));
    await api()
      .delete(`/v1/group-carts/${gid}/items/${hostLine.id}`)
      .set(bearer(friend.token))
      .expect(404);
    await api()
      .patch(`/v1/group-carts/${gid}/items/${friendLine.id}`)
      .set(bearer(host.token))
      .send({ quantity: 1 })
      .expect(200);

    await api()
      .put(`/v1/group-carts/${gid}/ready`)
      .set(bearer(friend.token))
      .send({ isReady: true })
      .expect(200);

    // Host's checkout quote: the shares add up to the total and follow item value.
    const q = await quote(host, withItem.cart.id, '?tipCentavos=1000');
    expect(q.memberShares).toHaveLength(2);
    const sum = q.memberShares.reduce((t, m) => t + m.amountDueCentavos, 0);
    expect(sum).toBe(q.cart.pricing.totalCentavos);
    const [hostShare, friendShare] = q.memberShares;
    expect(hostShare?.subtotalCentavos).toBe(10_000);
    expect(must(friendShare).amountDueCentavos).toBeGreaterThan(
      must(hostShare).amountDueCentavos * 2,
    );
    const view = (await api().get(`/v1/group-carts/${gid}`).set(bearer(friend.token)).expect(200))
      .body as GroupCart;
    expect(view.members.find((m) => m.displayName === 'Friend')?.amountDueCentavos).toBe(
      friendShare?.amountDueCentavos,
    );

    // Locked: members can't change anything.
    await api().post(`/v1/group-carts/${gid}/lock`).set(bearer(friend.token)).expect(403);
    await api().post(`/v1/group-carts/${gid}/lock`).set(bearer(host.token)).expect(200);
    await api()
      .post(`/v1/group-carts/${gid}/items`)
      .set(bearer(friend.token))
      .send({ productId: a.id, quantity: 1 })
      .expect(409);
    await api()
      .post('/v1/carts/items')
      .set(bearer(host.token))
      .send({ merchantId: s.merchantId, productId: a.id, quantity: 1 })
      .expect(409);
    await api().post(`/v1/group-carts/${gid}/unlock`).set(bearer(host.token)).expect(200);

    // Leaving drops the member's items.
    const left = await api()
      .delete(`/v1/group-carts/${gid}/members/${friendMember.id}`)
      .set(bearer(friend.token));
    expect(left.status).toBe(204);
    const after = (await api().get(`/v1/group-carts/${gid}`).set(bearer(host.token)).expect(200))
      .body as GroupCart;
    expect(after.cart.items.map((i) => i.productId)).toEqual([a.id]);
  });

  it('host cancels: the cart goes back to a normal cart', async () => {
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
      .set(bearer(host.token))
      .send({ productId: a.id, quantity: 2 })
      .expect(200);
    await api()
      .post(`/v1/group-carts/${g.id}/items`)
      .set(bearer(friend.token))
      .send({ productId: b.id, quantity: 1 })
      .expect(200);

    await api().delete(`/v1/group-carts/${g.id}`).set(bearer(friend.token)).expect(403);
    await api().delete(`/v1/group-carts/${g.id}`).set(bearer(host.token)).expect(204);
    const cart = (await api().get(`/v1/carts/${g.cart.id}`).set(bearer(host.token)).expect(200))
      .body as Cart;
    expect(cart.groupCartId).toBeNull();
    expect(cart.items.map((i) => [i.productId, i.quantity, i.memberId])).toEqual([[a.id, 2, null]]);
    await api()
      .post('/v1/group-carts/join')
      .set(bearer((await fx.customer()).token))
      .send({ code: g.code, displayName: 'Late' })
      .expect(409);
  });
});
