import { randomUUID } from 'node:crypto';
import {
  type CursorPage,
  type MerchantSummary,
  type ProductCard,
  type PublicCategory,
  type PublicProduct,
  type PublicStore,
  type SearchProductsResult,
  type StoreList,
  type Suggestions,
  toManilaParts,
} from '@ebalangay/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
let ctx: Ctx;
const api = () => request(ctx.app.server);
const db = () => ctx.app.db;

// A zone unique to this run so rows from other test files never show up.
const center = { lat: 6 + Math.random() * 10, lng: 119 + Math.random() * 6 };
const near = `lat=${center.lat}&lng=${center.lng}`;
let zoneId: string;

const ALWAYS_OPEN = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
  dayOfWeek: d,
  opensAt: '00:00',
  closesAt: '24:00',
}));

interface StoreOpts {
  name?: string;
  /** Metres north of the customer. */
  north?: number;
  open?: boolean;
  rating?: number;
  verified?: boolean;
  freeDelivery?: boolean;
  prep?: number;
  radius?: number;
  status?: 'active' | 'draft';
  zone?: string | null;
  businessType?: 'restaurant' | 'grocery';
}

async function mkStore(o: StoreOpts = {}) {
  const suffix = randomUUID().slice(0, 8);
  const m = await db().merchant.create({
    data: {
      slug: `browse-${suffix}`,
      name: o.name ?? `Store ${suffix}`,
      businessType: o.businessType ?? 'restaurant',
      status: o.status ?? 'active',
      phone: '+639171234567',
      addressLine: 'Test St',
      barangay: 'Test',
      city: 'Test City',
      province: 'Test',
      lat: center.lat + (o.north ?? 100) / 111_320,
      lng: center.lng,
      zoneId: o.zone === undefined ? zoneId : o.zone,
      ratingAverage: o.rating ?? 4,
      verifiedBadge: o.verified ?? false,
      freeDelivery: o.freeDelivery ?? false,
      prepTimeMinutes: o.prep ?? 20,
      deliveryRadiusM: o.radius ?? 5000,
      ...(o.open === false ? {} : { storeHours: { create: ALWAYS_OPEN } }),
    },
  });
  return m;
}

interface ProductOpts {
  name: string;
  price?: number;
  dietary?: string[];
  categoryId?: string;
  available?: boolean;
  stock?: number;
  deleted?: boolean;
  description?: string;
}

async function mkProduct(merchantId: string, o: ProductOpts) {
  return db().product.create({
    data: {
      merchantId,
      name: o.name,
      description: o.description ?? null,
      basePriceCentavos: BigInt(o.price ?? 15_000),
      dietaryTags: o.dietary ?? [],
      categoryId: o.categoryId ?? null,
      isAvailable: o.available ?? true,
      trackInventory: o.stock !== undefined,
      sku: `SKU-${randomUUID().slice(0, 6)}`,
      deletedAt: o.deleted ? new Date() : null,
      ...(o.stock !== undefined
        ? { inventoryLevels: { create: { merchantId, quantity: o.stock } } }
        : {}),
    },
  });
}

const stores = async (query = '') =>
  (await api().get(`/v1/stores?${near}${query}`).expect(200)).body as StoreList;
const ids = (items: { id: string }[]) => items.map((i) => i.id);

/** "HH:mm" for minutes since midnight (wraps). */
const hhmm = (min: number) => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

beforeAll(async () => {
  ctx = await buildTestApp({ env: { RATE_LIMIT_ENABLED: 'false' } });
  const d = 0.05;
  const { lat, lng } = center;
  const zone = await db().zone.create({
    data: {
      name: `browse-${randomUUID()}`,
      city: 'Test City',
      province: 'Test',
      boundaryGeojson: {
        type: 'Polygon',
        coordinates: [
          [
            [lng - d, lat - d],
            [lng + d, lat - d],
            [lng + d, lat + d],
            [lng - d, lat + d],
            [lng - d, lat - d],
          ],
        ],
      },
      baseDeliveryFeeCentavos: 4900n,
      perKmFeeCentavos: 1000n,
    },
  });
  zoneId = zone.id;
});
afterAll(async () => {
  await ctx.close();
});

describe('GET /v1/stores (nearby)', () => {
  let a: Awaited<ReturnType<typeof mkStore>>;
  let b: Awaited<ReturnType<typeof mkStore>>;
  let c: Awaited<ReturnType<typeof mkStore>>;
  let closed: Awaited<ReturnType<typeof mkStore>>;

  beforeAll(async () => {
    a = await mkStore({ north: 300, rating: 3.5, prep: 30, verified: true });
    b = await mkStore({ north: 100, rating: 4.8, prep: 10, freeDelivery: true });
    c = await mkStore({ north: 900, rating: 4.2, prep: 15, businessType: 'grocery' });
    closed = await mkStore({ north: 600, open: false, rating: 5 });
    // Never listed: too far for its radius, inactive, another zone.
    await mkStore({ north: 3000, radius: 1000 });
    await mkStore({ status: 'draft' });
    await mkStore({ zone: null });

    await mkProduct(a.id, { name: 'Vegan Lumpia', price: 8000, dietary: ['vegan'], stock: 0 });
    await mkProduct(b.id, { name: 'Halo-halo Supreme', price: 12_000, stock: 4 });
    await mkProduct(c.id, { name: 'Chicken Adobo', price: 9500, dietary: ['halal'] });
    await mkProduct(closed.id, { name: 'Lechon Kawali', price: 20_000 });
  });

  it('returns nothing (zoneId null) outside every zone', async () => {
    const res = await api().get('/v1/stores?lat=0&lng=0').expect(200);
    expect(res.body).toEqual({ items: [], nextCursor: null, zoneId: null });
  });

  it('lists stores that deliver here, nearest first', async () => {
    const page = await stores();
    expect(page.zoneId).toBe(zoneId);
    expect(ids(page.items)).toEqual([b.id, a.id, closed.id, c.id]);
    const first = page.items[0] as MerchantSummary;
    expect(first.distanceMeters).toBeGreaterThan(80);
    expect(first.distanceMeters).toBeLessThan(120);
    expect(first.isOpen).toBe(true);
    expect(page.items.find((s) => s.id === closed.id)?.closedReason).toBe('outside_hours');
  });

  it('filters by open now, rating, verified, free delivery and business type', async () => {
    expect(ids((await stores('&openNow=true')).items)).toEqual([b.id, a.id, c.id]);
    expect(ids((await stores('&minRating=4.5')).items)).toEqual([b.id, closed.id]);
    expect(ids((await stores('&verified=true')).items)).toEqual([a.id]);
    expect(ids((await stores('&freeDelivery=true')).items)).toEqual([b.id]);
    expect(ids((await stores('&businessType=grocery')).items)).toEqual([c.id]);
  });

  it('filters by what the store sells: dietary, budget, in stock', async () => {
    expect(ids((await stores('&dietary=vegan,halal')).items)).toEqual([a.id, c.id]);
    expect(ids((await stores('&budget=true')).items)).toEqual([a.id, c.id]);
    expect(ids((await stores('&inStock=true')).items)).toEqual([b.id, closed.id, c.id]);
    // One product must satisfy every product filter at once.
    expect(ids((await stores('&dietary=vegan&inStock=true')).items)).toEqual([]);
  });

  it('filters by store tag', async () => {
    const tag = await db().storeTag.create({
      data: { slug: `tag-${randomUUID().slice(0, 8)}`, name: 'Tagged' },
    });
    await db().merchantTag.create({ data: { merchantId: c.id, tagId: tag.id } });
    expect(ids((await stores(`&tag=${tag.slug}`)).items)).toEqual([c.id]);
  });

  it('sorts by rating and prep time', async () => {
    expect(ids((await stores('&sort=rating')).items)).toEqual([closed.id, b.id, c.id, a.id]);
    expect(ids((await stores('&sort=prep_time')).items)).toEqual([b.id, c.id, closed.id, a.id]);
  });

  it('pages with a cursor without gaps or repeats', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : '';
      const page = await stores(`&limit=1&sort=rating${qs}`);
      seen.push(...ids(page.items));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([closed.id, b.id, c.id, a.id]);
    await api().get(`/v1/stores?${near}&cursor=garbage`).expect(400);
  });

  it('searches store names (typo tolerant) and what stores sell', async () => {
    const lechon = await mkStore({ name: 'Mang Inasal Lechonan', north: 50 });
    expect(ids((await stores('&q=lechonan')).items)).toContain(lechon.id);
    expect(ids((await stores('&q=lechonon')).items)).toContain(lechon.id);
    expect(ids((await stores('&q=adobo')).items)).toEqual([c.id]);
    expect(ids((await stores('&q=adbo')).items)).toEqual([c.id]);
  });

  it('rejects bad queries', async () => {
    await api().get('/v1/stores').expect(400);
    await api().get(`/v1/stores?${near}&dietary=meat`).expect(400);
    await api().get(`/v1/stores?${near}&sort=price`).expect(400);
  });
});

describe('store page, categories and menu', () => {
  let store: Awaited<ReturnType<typeof mkStore>>;
  let breakfast: string;
  let dinner: string;
  let mains: string;
  let hidden: string;

  beforeAll(async () => {
    store = await mkStore({ name: 'Kusina ni Lola', north: 200 });
    const cat = (name: string, sortOrder: number, isActive = true) =>
      db().category.create({ data: { merchantId: store.id, name, sortOrder, isActive } });
    const [cB, cD, cM, cOff] = await Promise.all([
      cat('Breakfast', 0),
      cat('Dinner', 1),
      cat('Mains', 2),
      cat('Hidden', 3, false),
    ]);
    breakfast = cB.id;
    dinner = cD.id;
    mains = cM.id;
    hidden = cOff.id;

    const now = toManilaParts(new Date());
    const nowMin = now.hour * 60 + now.minute;
    await db().menuSchedule.createMany({
      data: [
        // Breakfast: live right now.
        {
          merchantId: store.id,
          name: 'Now',
          dayOfWeek: now.dayOfWeek,
          // Clamped to today so the window never wraps past midnight.
          startTime: hhmm(Math.max(0, nowMin - 60)),
          endTime: nowMin + 60 >= 1440 ? '24:00' : hhmm(nowMin + 60),
          categoryIds: [breakfast],
        },
        // Dinner: another day only.
        {
          merchantId: store.id,
          name: 'Later',
          dayOfWeek: (now.dayOfWeek + 3) % 7,
          startTime: '17:00',
          endTime: '21:00',
          categoryIds: [dinner],
        },
      ],
    });
    await mkProduct(store.id, { name: 'Tapsilog', categoryId: breakfast, price: 9000 });
    await mkProduct(store.id, { name: 'Sinigang', categoryId: dinner });
    await mkProduct(store.id, { name: 'Pancit', categoryId: mains, stock: 0 });
    await mkProduct(store.id, { name: 'Kare-kare', categoryId: mains, description: 'Oxtail' });
    await mkProduct(store.id, { name: 'Off menu', categoryId: mains, available: false });
    await mkProduct(store.id, { name: 'Deleted', categoryId: mains, deleted: true });
    await mkProduct(store.id, { name: 'Secret', categoryId: hidden });
  });

  it('shows the store page by slug or id, with distance', async () => {
    const bySlug = (await api().get(`/v1/stores/${store.slug}?${near}`).expect(200))
      .body as PublicStore;
    expect(bySlug.id).toBe(store.id);
    expect(bySlug.weekly).toHaveLength(7);
    expect(bySlug.distanceMeters).toBeGreaterThan(150);
    const byId = (await api().get(`/v1/stores/${store.id}`).expect(200)).body as PublicStore;
    expect(byId.distanceMeters).toBeNull();
    expect(byId).not.toHaveProperty('commissionBps');
    await api().get(`/v1/stores/${store.id}?lat=1`).expect(400);
  });

  it('404s for stores that are not active', async () => {
    const draft = await mkStore({ status: 'draft' });
    await api().get(`/v1/stores/${draft.slug}`).expect(404);
    await api().get(`/v1/stores/${draft.id}/products`).expect(404);
  });

  it('lists only categories with something on the menu now', async () => {
    const res = await api().get(`/v1/stores/${store.id}/categories`).expect(200);
    const page = res.body as CursorPage<PublicCategory>;
    expect(page.items.map((c) => [c.name, c.productCount])).toEqual([
      ['Breakfast', 1],
      ['Mains', 2],
    ]);
    const p1 = (await api().get(`/v1/stores/${store.id}/categories?limit=1`).expect(200))
      .body as CursorPage<PublicCategory>;
    const p2 = (
      await api().get(`/v1/stores/${store.id}/categories?limit=1&cursor=${p1.nextCursor}`)
    ).body as CursorPage<PublicCategory>;
    expect([...ids(p1.items), ...ids(p2.items)]).toEqual([breakfast, mains]);
    expect(p2.nextCursor).toBeNull();
  });

  it('lists menu items visible now, with filters', async () => {
    const list = async (qs = '') =>
      (
        (await api().get(`/v1/stores/${store.id}/products?${qs}`).expect(200))
          .body as CursorPage<ProductCard>
      ).items.map((p) => p.name);
    expect((await list()).sort()).toEqual(['Kare-kare', 'Pancit', 'Tapsilog']);
    expect((await list(`categoryId=${mains}&inStock=true`)).sort()).toEqual(['Kare-kare']);
    expect(await list('q=oxtail')).toEqual(['Kare-kare']);
    expect(await list('budget=true')).toEqual(['Tapsilog']);
    expect(await list(`categoryId=${dinner}`)).toEqual([]);

    const page = (await api().get(`/v1/stores/${store.id}/products?limit=2`).expect(200))
      .body as CursorPage<ProductCard>;
    const rest = (
      await api().get(`/v1/stores/${store.id}/products?limit=2&cursor=${page.nextCursor}`)
    ).body as CursorPage<ProductCard>;
    expect(page.items).toHaveLength(2);
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
  });

  it('shows product detail without internal fields; hides off-menu items', async () => {
    const pancit = await db().product.findFirstOrThrow({
      where: { merchantId: store.id, name: 'Pancit' },
    });
    const res = await api().get(`/v1/stores/${store.id}/products/${pancit.id}`).expect(200);
    const p = res.body as PublicProduct;
    expect(p.isSoldOut).toBe(true);
    expect(p).not.toHaveProperty('sku');
    expect(p).not.toHaveProperty('stock');

    for (const name of ['Sinigang', 'Off menu', 'Deleted', 'Secret']) {
      const row = await db().product.findFirstOrThrow({ where: { merchantId: store.id, name } });
      await api().get(`/v1/stores/${store.id}/products/${row.id}`).expect(404);
    }
  });
});

describe('GET /v1/search', () => {
  let s1: Awaited<ReturnType<typeof mkStore>>;
  let s2: Awaited<ReturnType<typeof mkStore>>;

  beforeAll(async () => {
    s1 = await mkStore({ name: 'Bahay Kubo Eatery', north: 400 });
    s2 = await mkStore({ name: 'Paresan sa Kanto', north: 700, open: false });
    const far = await mkStore({ north: 4000, radius: 1000 });
    await mkProduct(s1.id, { name: 'Bulalo Special', dietary: ['halal'] });
    await mkProduct(s1.id, { name: 'Beef Pares', price: 9000 });
    await mkProduct(s2.id, { name: 'Pares Overload', description: 'Beef pares with rice' });
    await mkProduct(far.id, { name: 'Bulalo Far Away' });
  });

  const search = async (qs: string) =>
    (await api().get(`/v1/search/products?${near}&${qs}`).expect(200)).body as SearchProductsResult;

  it('finds items by prefix and with typos, only from stores that deliver here', async () => {
    const bul = await search('q=bula');
    expect(bul.items.map((h) => h.product.name)).toEqual(['Bulalo Special']);
    expect(bul.items[0]?.store.id).toBe(s1.id);
    expect((await search('q=bulallo')).items.map((h) => h.product.name)).toEqual([
      'Bulalo Special',
    ]);
  });

  it('pages ranked results with a cursor', async () => {
    const all = await search('q=pares');
    expect(all.items.map((h) => h.product.name)).toEqual(
      expect.arrayContaining(['Beef Pares', 'Pares Overload']),
    );
    const p1 = await search('q=pares&limit=1');
    const p2 = await search(`q=pares&limit=1&cursor=${p1.nextCursor}`);
    expect([...p1.items, ...p2.items].map((h) => h.product.id)).toEqual(
      all.items.map((h) => h.product.id),
    );
  });

  it('applies open-now, dietary and budget filters', async () => {
    expect((await search('q=pares&openNow=true')).items.map((h) => h.product.name)).toEqual([
      'Beef Pares',
    ]);
    expect((await search('q=bulalo&dietary=vegan')).items).toEqual([]);
    expect((await search('q=pares&budget=true')).items.map((h) => h.product.name)).toEqual([
      'Beef Pares',
    ]);
  });

  it('suggests stores and item names', async () => {
    const res = await api().get(`/v1/search/suggest?${near}&q=pare`).expect(200);
    const s = res.body as Suggestions;
    expect(s.stores.map((x) => x.id)).toContain(s2.id);
    expect(s.products).toEqual(expect.arrayContaining(['Beef Pares', 'Pares Overload']));
    await api().get(`/v1/search/suggest?q=pare`).expect(400);
  });
});
