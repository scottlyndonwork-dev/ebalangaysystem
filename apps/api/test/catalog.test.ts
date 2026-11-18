import { randomUUID } from 'node:crypto';
import {
  ALL_MERCHANT_PERMISSIONS,
  type CatalogImportReport,
  type CursorPage,
  type InventoryItem,
  type MenuSchedule,
  type Product,
  type ProductCategory,
  type StockMovement,
  type UserRole,
} from '@ebalangay/shared';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, randomPhone } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
let ctx: Ctx;

const api = () => request(ctx.app.server);
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function tokenFor(userId: string, roles: UserRole[] = ['customer']): string {
  return ctx.app.jwt.sign({
    typ: 'access',
    sub: userId,
    roles,
    app: 'merchant',
    sid: randomUUID(),
  });
}

/** Active store with an owner (all permissions) and a cashier (no catalog/inventory rights). */
async function store(businessType: 'restaurant' | 'supplier' = 'restaurant') {
  const db = ctx.app.db;
  const owner = await db.user.create({ data: { phone: randomPhone(), roles: ['merchant_owner'] } });
  const cashier = await db.user.create({
    data: { phone: randomPhone(), roles: ['merchant_staff'] },
  });
  const m = await db.merchant.create({
    data: {
      slug: `test-${randomUUID().slice(0, 8)}`,
      name: 'Test Store',
      businessType,
      status: 'active',
      phone: '+639171234567',
      addressLine: 'J.C. Aquino Ave',
      barangay: 'Libertad',
      city: 'Butuan City',
      province: 'Agusan del Norte',
      lat: 8.9475,
      lng: 125.5406,
    },
  });
  await db.merchantStaff.createMany({
    data: [
      {
        merchantId: m.id,
        userId: owner.id,
        displayName: 'Owner',
        rolePreset: 'owner',
        permissions: [...ALL_MERCHANT_PERMISSIONS],
      },
      {
        merchantId: m.id,
        userId: cashier.id,
        displayName: 'Cashier',
        rolePreset: 'cashier',
        permissions: ['orders.manage', 'pos.use'],
      },
    ],
  });
  const base = `/v1/merchants/${m.id}`;
  return { merchantId: m.id, base, owner: tokenFor(owner.id), cashier: tokenFor(cashier.id) };
}

type Store = Awaited<ReturnType<typeof store>>;

async function createProduct(s: Store, body: Record<string, unknown>): Promise<Product> {
  const res = await api().post(`${s.base}/products`).set(auth(s.owner)).send(body).expect(201);
  return res.body as Product;
}

async function stock(s: Store, productId: string, body: Record<string, unknown>, status = 200) {
  const res = await api()
    .post(`${s.base}/products/${productId}/stock`)
    .set(auth(s.owner))
    .send(body)
    .expect(status);
  return res.body as Product;
}

const merchantOf = (id: string) => ctx.app.db.merchant.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  ctx = await buildTestApp({ env: { RATE_LIMIT_ENABLED: 'false' } });
});
afterAll(async () => {
  await ctx.close();
});

describe('categories', () => {
  it('creates, lists in order, reorders, renames and deletes', async () => {
    const s = await store();
    const mk = async (name: string) =>
      (await api().post(`${s.base}/categories`).set(auth(s.owner)).send({ name }).expect(201))
        .body as ProductCategory;
    const a = await mk('Meals');
    const b = await mk('Drinks');
    expect([a.sortOrder, b.sortOrder]).toEqual([0, 1]);

    await api()
      .put(`${s.base}/categories/order`)
      .set(auth(s.owner))
      .send({ ids: [b.id, a.id] })
      .expect(204);
    const list = (await api().get(`${s.base}/categories`).set(auth(s.owner)).expect(200))
      .body as CursorPage<ProductCategory>;
    expect(list.items.map((c) => c.name)).toEqual(['Drinks', 'Meals']);

    // Pagination walks every row once.
    const p1 = (await api().get(`${s.base}/categories?limit=1`).set(auth(s.owner)).expect(200))
      .body as CursorPage<ProductCategory>;
    const p2 = (
      await api()
        .get(`${s.base}/categories?limit=1&cursor=${p1.nextCursor}`)
        .set(auth(s.owner))
        .expect(200)
    ).body as CursorPage<ProductCategory>;
    expect([...p1.items, ...p2.items].map((c) => c.id)).toEqual([b.id, a.id]);
    expect(p2.nextCursor).toBeNull();

    const p = await createProduct(s, { name: 'Adobo', basePriceCentavos: 9000, categoryId: a.id });
    await api()
      .patch(`${s.base}/categories/${a.id}`)
      .set(auth(s.owner))
      .send({ name: 'Rice meals' })
      .expect(200);
    await api().delete(`${s.base}/categories/${a.id}`).set(auth(s.owner)).expect(204);
    const after = (await api().get(`${s.base}/products/${p.id}`).set(auth(s.owner)).expect(200))
      .body as Product;
    expect(after.categoryId).toBeNull();
  });

  it('requires catalog.edit and membership of the store', async () => {
    const s = await store();
    const other = await store();
    await api().post(`${s.base}/categories`).set(auth(s.cashier)).send({ name: 'X' }).expect(403);
    await api().get(`${s.base}/categories`).set(auth(s.cashier)).expect(200);
    await api().post(`${s.base}/categories`).set(auth(other.owner)).send({ name: 'X' }).expect(403);
  });

  it("can't attach another store's category to a product", async () => {
    const s = await store();
    const other = await store();
    const foreign = (
      await api()
        .post(`${other.base}/categories`)
        .set(auth(other.owner))
        .send({ name: 'Theirs' })
        .expect(201)
    ).body as ProductCategory;
    await api()
      .post(`${s.base}/products`)
      .set(auth(s.owner))
      .send({ name: 'X', basePriceCentavos: 100, categoryId: foreign.id })
      .expect(400);
  });
});

describe('products', () => {
  it('creates a product with variants, modifiers and opening stock', async () => {
    const s = await store();
    const p = await createProduct(s, {
      name: 'Milk tea',
      basePriceCentavos: 9900,
      dietaryTags: ['vegetarian', 'vegetarian'],
      trackInventory: true,
      variants: [
        { name: 'Regular', priceCentavos: 9900, initialStock: 10 },
        { name: 'Large', priceCentavos: 12900, initialStock: 0 },
      ],
      modifierGroups: [
        {
          name: 'Sinkers',
          minSelect: 0,
          maxSelect: 2,
          options: [
            { name: 'Pearls', priceDeltaCentavos: 1500 },
            { name: 'No ice', priceDeltaCentavos: 0 },
          ],
        },
      ],
    });
    expect(p.dietaryTags).toEqual(['vegetarian']);
    expect(p.variants.map((v) => [v.name, v.stock?.quantity])).toEqual([
      ['Regular', 10],
      ['Large', 0],
    ]);
    expect(p.variants[1]?.stock?.isSoldOut).toBe(true);
    expect(p.isSoldOut).toBe(false);
    expect(p.stock).toBeNull();
    expect(p.modifierGroups[0]?.options).toHaveLength(2);

    const moves = (
      await api()
        .get(`${s.base}/inventory/movements?productId=${p.id}`)
        .set(auth(s.owner))
        .expect(200)
    ).body as CursorPage<StockMovement>;
    expect(moves.items).toHaveLength(1);
    expect(moves.items[0]).toMatchObject({ delta: 10, reason: 'restock' });
  });

  it('updates with optimistic locking and syncs variants by id', async () => {
    const s = await store();
    const p = await createProduct(s, {
      name: 'Silog',
      basePriceCentavos: 8000,
      variants: [
        { name: 'Tapsilog', priceCentavos: 9000 },
        { name: 'Longsilog', priceCentavos: 8500 },
      ],
    });
    const [tapa] = p.variants;
    const res = await api()
      .patch(`${s.base}/products/${p.id}`)
      .set(auth(s.owner))
      .send({
        version: p.version,
        name: 'Silog meals',
        variants: [
          { id: tapa?.id, name: 'Tapsilog', priceCentavos: 9500 },
          { name: 'Bangsilog', priceCentavos: 9900 },
        ],
      })
      .expect(200);
    const updated = res.body as Product;
    expect(updated.version).toBe(p.version + 1);
    expect(updated.variants.map((v) => [v.name, v.priceCentavos])).toEqual([
      ['Tapsilog', 9500],
      ['Bangsilog', 9900],
    ]);
    expect(updated.variants[0]?.id).toBe(tapa?.id);

    // Stale version → 409, nothing changed.
    await api()
      .patch(`${s.base}/products/${p.id}`)
      .set(auth(s.owner))
      .send({ version: p.version, name: 'Lost update' })
      .expect(409);

    // A variant id from another product is rejected.
    const other = await createProduct(s, {
      name: 'Other',
      basePriceCentavos: 100,
      variants: [{ name: 'X', priceCentavos: 100 }],
    });
    await api()
      .patch(`${s.base}/products/${p.id}`)
      .set(auth(s.owner))
      .send({
        version: updated.version,
        variants: [{ id: other.variants[0]?.id, name: 'X', priceCentavos: 1 }],
      })
      .expect(400);
  });

  it('allows wholesale tiers only for suppliers and wholesalers', async () => {
    const retail = await store('restaurant');
    const body = {
      name: 'Rice 25kg',
      basePriceCentavos: 130000,
      variants: [{ name: 'Dinorado', priceCentavos: 140000 }],
      wholesaleTiers: [
        { minQuantity: 10, unitPriceCentavos: 120000 },
        { variantIndex: 0, minQuantity: 10, unitPriceCentavos: 130000 },
      ],
    };
    await api().post(`${retail.base}/products`).set(auth(retail.owner)).send(body).expect(403);

    const supplier = await store('supplier');
    const p = await createProduct(supplier, body);
    expect(p.wholesaleTiers).toEqual([
      { variantId: null, minQuantity: 10, unitPriceCentavos: 120000 },
      { variantId: p.variants[0]?.id, minQuantity: 10, unitPriceCentavos: 130000 },
    ]);
    await api()
      .post(`${supplier.base}/products`)
      .set(auth(supplier.owner))
      .send({
        ...body,
        wholesaleTiers: [{ variantIndex: 3, minQuantity: 2, unitPriceCentavos: 1 }],
      })
      .expect(400);
  });

  it('lists, searches, reorders and soft-deletes', async () => {
    const s = await store();
    const a = await createProduct(s, {
      name: 'Pancit Canton',
      basePriceCentavos: 5000,
      sku: 'PC-1',
    });
    const b = await createProduct(s, {
      name: 'Lumpia',
      basePriceCentavos: 3000,
      isAvailable: false,
    });
    const list = async (qs = '') =>
      (
        (await api().get(`${s.base}/products${qs}`).set(auth(s.owner)).expect(200))
          .body as CursorPage<Product>
      ).items.map((p) => p.name);
    expect(await list()).toEqual(['Pancit Canton', 'Lumpia']);
    expect(await list('?q=canton')).toEqual(['Pancit Canton']);
    expect(await list('?q=pc-1')).toEqual(['Pancit Canton']);
    expect(await list('?available=false')).toEqual(['Lumpia']);

    await api()
      .put(`${s.base}/products/order`)
      .set(auth(s.owner))
      .send({ ids: [b.id, a.id] })
      .expect(204);
    expect(await list()).toEqual(['Lumpia', 'Pancit Canton']);

    await api().delete(`${s.base}/products/${a.id}`).set(auth(s.owner)).expect(204);
    expect(await list()).toEqual(['Lumpia']);
    await api().get(`${s.base}/products/${a.id}`).set(auth(s.owner)).expect(404);
    await api().delete(`${s.base}/products/${a.id}`).set(auth(s.owner)).expect(404);
  });

  it("hides another store's products (authZ + RLS)", async () => {
    const s = await store();
    const other = await store();
    const p = await createProduct(other, { name: 'Secret', basePriceCentavos: 100 });
    await api().get(`${s.base}/products/${p.id}`).set(auth(s.owner)).expect(404);
    await api().get(`${other.base}/products/${p.id}`).set(auth(s.owner)).expect(403);
  });
});

describe('inventory', () => {
  it('sets and adjusts stock, rejects going negative, logs every movement', async () => {
    const s = await store();
    const p = await createProduct(s, {
      name: 'Pandesal',
      basePriceCentavos: 500,
      trackInventory: true,
    });
    expect(p.stock).toMatchObject({ quantity: 0, isSoldOut: true });
    expect(p.isSoldOut).toBe(true);

    let after = await stock(s, p.id, {
      mode: 'set',
      quantity: 20,
      reason: 'restock',
      lowStockThreshold: 5,
    });
    expect(after.stock).toMatchObject({ quantity: 20, isLow: false, isSoldOut: false });
    after = await stock(s, p.id, { mode: 'adjust', quantity: -16, reason: 'waste', note: 'stale' });
    expect(after.stock).toMatchObject({ quantity: 4, isLow: true });

    const err = await api()
      .post(`${s.base}/products/${p.id}/stock`)
      .set(auth(s.owner))
      .send({ mode: 'adjust', quantity: -5, reason: 'adjustment' })
      .expect(422);
    expect(err.body.error.code).toBe('OUT_OF_STOCK');

    const moves = (await api().get(`${s.base}/inventory/movements`).set(auth(s.owner)).expect(200))
      .body as CursorPage<StockMovement>;
    expect(moves.items.map((m) => [m.delta, m.reason])).toEqual([
      [-16, 'waste'],
      [20, 'restock'],
    ]);

    const low = (await api().get(`${s.base}/inventory?low=true`).set(auth(s.owner)).expect(200))
      .body as CursorPage<InventoryItem>;
    expect(low.items.map((i) => i.productId)).toEqual([p.id]);
  });

  it('validates the stock target and permissions', async () => {
    const s = await store();
    const untracked = await createProduct(s, { name: 'Ice', basePriceCentavos: 100 });
    await stock(s, untracked.id, { mode: 'set', quantity: 1, reason: 'restock' }, 409);

    const withVariants = await createProduct(s, {
      name: 'Shirt',
      basePriceCentavos: 100,
      trackInventory: true,
      variants: [{ name: 'S', priceCentavos: 100 }],
    });
    await stock(s, withVariants.id, { mode: 'set', quantity: 1, reason: 'restock' }, 400);
    await stock(
      s,
      withVariants.id,
      { variantId: randomUUID(), mode: 'set', quantity: 1, reason: 'restock' },
      404,
    );
    const ok = await stock(s, withVariants.id, {
      variantId: withVariants.variants[0]?.id,
      mode: 'set',
      quantity: 3,
      reason: 'restock',
    });
    expect(ok.variants[0]?.stock?.quantity).toBe(3);

    await api()
      .post(`${s.base}/products/${withVariants.id}/stock`)
      .set(auth(s.cashier))
      .send({
        variantId: withVariants.variants[0]?.id,
        mode: 'set',
        quantity: 1,
        reason: 'restock',
      })
      .expect(403);
    // Sale/cancel come from orders, never by hand.
    await stock(s, untracked.id, { mode: 'set', quantity: 1, reason: 'sale' }, 400);
  });

  it('auto-pauses the store when a key product sells out and resumes on restock', async () => {
    const s = await store();
    const p = await createProduct(s, {
      name: 'Lechon',
      basePriceCentavos: 50000,
      trackInventory: true,
      isKey: true,
      initialStock: 2,
    });
    expect((await merchantOf(s.merchantId)).autoPausedReason).toBeNull();

    await stock(s, p.id, { mode: 'adjust', quantity: -2, reason: 'adjustment' });
    expect((await merchantOf(s.merchantId)).autoPausedReason).toBe('key_product_sold_out');

    await stock(s, p.id, { mode: 'set', quantity: 5, reason: 'restock' });
    expect((await merchantOf(s.merchantId)).autoPausedReason).toBeNull();

    // Un-keying a sold-out product lifts the pause too.
    const sold = await stock(s, p.id, { mode: 'set', quantity: 0, reason: 'adjustment' });
    expect((await merchantOf(s.merchantId)).autoPausedReason).toBe('key_product_sold_out');
    await api()
      .patch(`${s.base}/products/${p.id}`)
      .set(auth(s.owner))
      .send({ version: sold.version, isKey: false })
      .expect(200);
    expect((await merchantOf(s.merchantId)).autoPausedReason).toBeNull();
  });
});

describe('product images', () => {
  const png = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: '#e85d04' } })
      .png()
      .toBuffer();

  it('stores WebP thumb/display/full renditions and cleans up on delete', async () => {
    const s = await store();
    const p = await createProduct(s, { name: 'Halo-halo', basePriceCentavos: 12000 });
    const res = await api()
      .post(`${s.base}/products/${p.id}/images`)
      .set(auth(s.owner))
      .attach('file', await png(1600, 1200), 'photo.png')
      .expect(201);
    const withImage = res.body as Product;
    const img = withImage.images[0];
    if (!img) throw new Error('no image returned');
    expect(img?.thumbUrl).toMatch(/\/thumb\.webp$/);
    expect(withImage.version).toBe(p.version + 1);

    const keyOf = (url: string) => url.replace('https://cdn.test/', '');
    const meta = async (url: string) => {
      const o = ctx.storage.objects.get(`public/${keyOf(url)}`);
      if (!o) throw new Error(`missing ${url}`);
      expect(o.contentType).toBe('image/webp');
      return sharp(o.body).metadata();
    };
    expect(await meta(img.thumbUrl)).toMatchObject({ format: 'webp', width: 200, height: 200 });
    expect(await meta(img.displayUrl)).toMatchObject({ width: 800, height: 600 });
    expect(await meta(img.url)).toMatchObject({ width: 1600, height: 1200 });

    await api()
      .delete(`${s.base}/products/${p.id}/images/${img.id}`)
      .set(auth(s.owner))
      .expect(200);
    expect(ctx.storage.objects.has(`public/${keyOf(img.url)}`)).toBe(false);
  });

  it('rejects non-images and reorders', async () => {
    const s = await store();
    const p = await createProduct(s, { name: 'Kakanin', basePriceCentavos: 3000 });
    await api()
      .post(`${s.base}/products/${p.id}/images`)
      .set(auth(s.owner))
      .attach('file', Buffer.from('not an image'), 'x.png')
      .expect(400);
    await api().post(`${s.base}/products/${p.id}/images`).set(auth(s.owner)).expect(406);

    const up = async () =>
      (
        await api()
          .post(`${s.base}/products/${p.id}/images`)
          .set(auth(s.owner))
          .attach('file', await png(300, 300), 'a.png')
          .expect(201)
      ).body as Product;
    await up();
    const two = await up();
    const ids = two.images.map((i) => i.id).reverse();
    const reordered = (
      await api()
        .put(`${s.base}/products/${p.id}/images/order`)
        .set(auth(s.owner))
        .send({ ids })
        .expect(200)
    ).body as Product;
    expect(reordered.images.map((i) => i.id)).toEqual(ids);
  });
});

describe('menu schedules', () => {
  it("creates, replaces and deletes; rejects other stores' ids", async () => {
    const s = await store();
    const other = await store();
    const mine = await createProduct(s, { name: 'Champorado', basePriceCentavos: 6000 });
    const theirs = await createProduct(other, { name: 'Theirs', basePriceCentavos: 100 });
    const body = {
      name: 'Breakfast',
      dayOfWeek: 1,
      startTime: '06:00',
      endTime: '10:30',
      productIds: [mine.id],
    };
    await api()
      .post(`${s.base}/menu-schedules`)
      .set(auth(s.owner))
      .send({ ...body, productIds: [theirs.id] })
      .expect(400);
    await api()
      .post(`${s.base}/menu-schedules`)
      .set(auth(s.owner))
      .send({ ...body, endTime: '06:00' })
      .expect(400);
    const created = (
      await api().post(`${s.base}/menu-schedules`).set(auth(s.owner)).send(body).expect(201)
    ).body as MenuSchedule;
    const replaced = (
      await api()
        .put(`${s.base}/menu-schedules/${created.id}`)
        .set(auth(s.owner))
        .send({ ...body, startTime: '22:00', endTime: '02:00' })
        .expect(200)
    ).body as MenuSchedule;
    expect([replaced.startTime, replaced.endTime]).toEqual(['22:00', '02:00']);
    await api().delete(`${s.base}/menu-schedules/${created.id}`).set(auth(s.owner)).expect(204);
    const list = (await api().get(`${s.base}/menu-schedules`).set(auth(s.owner)).expect(200))
      .body as CursorPage<MenuSchedule>;
    expect(list.items).toHaveLength(0);
  });
});

describe('CSV import', () => {
  const upload = (s: Store, csv: string, qs = '') =>
    api()
      .post(`${s.base}/catalog/import${qs}`)
      .set(auth(s.owner))
      .attach('file', Buffer.from(csv), 'catalog.csv');

  it('reports every row error and writes nothing', async () => {
    const s = await store();
    const csv = [
      'name,price,sku,category,stock,track_inventory,dietary_tags',
      'Adobo,90,A1,Meals,,,',
      ',abc,A2,Meals,,,',
      'Sinigang,120,A1,Meals,5,,keto',
    ].join('\n');
    const report = (await upload(s, csv).expect(200)).body as CatalogImportReport;
    expect(report.applied).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 3, column: 'name' }),
        expect.objectContaining({ line: 3, column: 'price' }),
        expect.objectContaining({ line: 4, column: 'sku' }),
        expect.objectContaining({ line: 4, column: 'stock' }),
        expect.objectContaining({ line: 4, column: 'dietary_tags' }),
      ]),
    );
    expect(await ctx.app.db.product.count({ where: { merchantId: s.merchantId } })).toBe(0);
    expect(await ctx.app.db.category.count({ where: { merchantId: s.merchantId } })).toBe(0);
  });

  it('rejects unknown columns', async () => {
    const s = await store();
    const report = (await upload(s, 'name,price,colour\nA,1,red').expect(200))
      .body as CatalogImportReport;
    expect(report.errors[0]).toMatchObject({ line: 1, message: expect.stringContaining('colour') });
  });

  it('dry-runs, then creates and updates by SKU in one go', async () => {
    const s = await store();
    const existing = await createProduct(s, {
      name: 'Old name',
      basePriceCentavos: 100,
      sku: 'B1',
    });
    const csv = [
      '﻿Name,Price,SKU,Category,Stock,Track_Inventory,Dietary_Tags,Is_Key',
      'Bibingka,"1,250.50",B1,Kakanin,8,true,vegetarian|gluten_free,',
      'Puto,45,,kakanin,,,,',
      'Taho,25,T1,Drinks,0,yes,,true',
    ].join('\r\n');

    const dry = (await upload(s, csv, '?dryRun=true').expect(200)).body as CatalogImportReport;
    expect(dry).toMatchObject({
      applied: false,
      rowCount: 3,
      created: 2,
      updated: 1,
      categoriesCreated: 2,
    });
    expect(dry.errors).toEqual([]);
    expect(await ctx.app.db.product.count({ where: { merchantId: s.merchantId } })).toBe(1);

    const done = (await upload(s, csv).expect(200)).body as CatalogImportReport;
    expect(done).toMatchObject({ applied: true, created: 2, updated: 1, categoriesCreated: 2 });

    const updated = (
      await api().get(`${s.base}/products/${existing.id}`).set(auth(s.owner)).expect(200)
    ).body as Product;
    expect(updated).toMatchObject({
      name: 'Bibingka',
      basePriceCentavos: 125050,
      trackInventory: true,
      dietaryTags: ['vegetarian', 'gluten_free'],
      stock: { quantity: 8 },
    });
    const cats = await ctx.app.db.category.findMany({ where: { merchantId: s.merchantId } });
    expect(cats.map((c) => c.name).sort()).toEqual(['Drinks', 'Kakanin']);
    // Taho is a key product imported at 0 stock → store auto-paused.
    expect((await merchantOf(s.merchantId)).autoPausedReason).toBe('key_product_sold_out');
  });
});
