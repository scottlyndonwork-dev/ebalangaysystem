import {
  BUDGET_PRICE_CENTAVOS,
  browseStoresQuerySchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  isVisibleOnMenu,
  manilaDateKey,
  type MerchantSummary,
  type ProductCard,
  type PublicCategory,
  productCardSchema,
  publicCategorySchema,
  publicProductSchema,
  type PublicStore,
  publicStoreSchema,
  storeListSchema,
  storeLocationQuerySchema,
  storeProductsQuerySchema,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Tx } from '../../db.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { productInclude } from '../catalog/service.js';
import { holidayOf } from '../merchants/service.js';
import {
  estimateStoreDelivery,
  loadBrowsePricing,
  loadPrepMedians,
  loadZonePricing,
} from '../pricing/context.js';
import { loadPricingSettings } from '../pricing/settings.js';
import {
  type Keyset,
  decodeKeyset,
  deliversTo,
  distanceTo,
  encodeKeyset,
  hasProductFilters,
  loadStores,
  notPaused,
  productConditions,
  scanPage,
  storeInclude,
  storeNameMatches,
  toCard,
  toPublicProduct,
  toSummary,
  withTrigramSearch,
  zoneAt,
} from './service.js';
import { cachedSchedules } from '../catalog/menu-cache.js';

const tags = ['browse'];
const storeParams = z.object({ merchantId: z.uuid() });
/** The store page also takes a slug, for share links. */
const storePageParams = z.object({
  merchantId: z.union([z.uuid(), z.string().regex(/^[a-z0-9-]{3,60}$/)]),
});
const productParams = storeParams.extend({ productId: z.uuid() });
const idCursor = (cursor: string | undefined) => {
  if (cursor && !z.uuid().safeParse(cursor).success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid cursor');
  }
  return cursor ?? null;
};

/** Customers browse active stores only; everything else is a 404. */
async function assertActiveStore(db: Db, merchantId: string): Promise<void> {
  const m = await db.merchant.findUnique({ where: { id: merchantId }, select: { status: true } });
  if (m?.status !== 'active') throw new AppError('NOT_FOUND', 'Store not found');
}

/** Live, orderable products of a store (category, if any, must be active). */
const liveProductWhere = (merchantId: string): Prisma.ProductWhereInput => ({
  merchantId,
  deletedAt: null,
  isAvailable: true,
  OR: [{ categoryId: null }, { category: { isActive: true } }],
});

interface StoreHitRow {
  id: string;
  distance_m: number;
  sort_key: number;
}

/** Public browse under /v1/stores (no auth). */
export async function browseStoreRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/',
    {
      schema: {
        tags,
        summary: 'Nearby stores that deliver to the given point',
        querystring: browseStoresQuerySchema,
        response: { 200: storeListSchema },
      },
    },
    async (req) => {
      const q = req.query;
      const now = new Date();
      const zoneId = await zoneAt(app.db, q.lat, q.lng);
      if (!zoneId) return { items: [], nextCursor: null, zoneId: null };

      const where = [deliversTo(zoneId, q.lat, q.lng)];
      if (q.businessType)
        where.push(Prisma.sql`m.business_type = ${q.businessType}::"BusinessType"`);
      if (q.tag) {
        where.push(Prisma.sql`EXISTS (SELECT 1 FROM merchant_store_tags mt JOIN store_tags t
          ON t.id = mt.tag_id WHERE mt.merchant_id = m.id AND t.slug = ${q.tag})`);
      }
      if (q.openNow) where.push(notPaused); // hours are checked per row below
      if (q.minRating !== undefined) where.push(Prisma.sql`m.rating_average >= ${q.minRating}`);
      if (q.verified) where.push(Prisma.sql`m.verified_badge`);
      if (q.freeDelivery) where.push(Prisma.sql`m.free_delivery`);
      const sellsMatching = (text?: string) =>
        Prisma.sql`EXISTS (SELECT 1 FROM products p LEFT JOIN categories c ON c.id = p.category_id
          WHERE p.merchant_id = m.id AND (c.id IS NULL OR c.is_active)
          AND ${productConditions(q, text)})`;
      if (hasProductFilters(q)) where.push(sellsMatching());
      if (q.q) where.push(Prisma.sql`(${storeNameMatches(q.q)} OR ${sellsMatching(q.q)})`);

      const sortKey =
        q.sort === 'rating'
          ? Prisma.sql`-m.rating_average::float8`
          : q.sort === 'prep_time'
            ? Prisma.sql`m.prep_time_minutes::float8`
            : distanceTo(q.lat, q.lng);

      const zonePricing = await loadZonePricing(
        app.db,
        zoneId,
        now,
        await loadPricingSettings(app.db),
      );
      const run = (db: Db | Tx) =>
        scanPage<StoreHitRow, MerchantSummary, Keyset>({
          start: decodeKeyset(q.cursor),
          limit: q.limit,
          fetch: (after, take) => db.$queryRaw<StoreHitRow[]>`
            SELECT * FROM (
              SELECT m.id, ${distanceTo(q.lat, q.lng)} AS distance_m, (${sortKey})::float8 AS sort_key
              FROM merchants m WHERE ${Prisma.join(where, ' AND ')}
            ) s
            ${after ? Prisma.sql`WHERE (s.sort_key, s.id) > (${after.k}::float8, ${after.id}::uuid)` : Prisma.empty}
            ORDER BY s.sort_key, s.id LIMIT ${take}::int`,
          keyOf: (row) => ({ k: row.sort_key, id: row.id }),
          map: async (rows) => {
            const ids = rows.map((row) => row.id);
            const stores = await loadStores(db, ids, now);
            const prep = zonePricing ? await loadPrepMedians(db, ids, now) : null;
            return rows.map((row) => {
              const m = stores.get(row.id);
              const delivery =
                m && zonePricing
                  ? estimateStoreDelivery(zonePricing, m, row.distance_m, prep?.get(m.id))
                  : null;
              const s = m ? toSummary(m, row.distance_m, now, delivery) : null;
              return s && (!q.openNow || s.isOpen) ? s : null;
            });
          },
        });
      const page = q.q ? await withTrigramSearch(app.db, run) : await run(app.db);
      return {
        items: page.items,
        nextCursor: page.next ? encodeKeyset(page.next) : null,
        zoneId,
      };
    },
  );

  r.get(
    '/:merchantId',
    {
      schema: {
        tags,
        summary: 'Store page (by id or slug)',
        params: storePageParams,
        querystring: storeLocationQuerySchema,
        response: { 200: publicStoreSchema },
      },
    },
    async (req): Promise<PublicStore> => {
      const now = new Date();
      const key = req.params.merchantId;
      const isId = z.uuid().safeParse(key).success;
      const m = await app.db.merchant.findFirst({
        where: { ...(isId ? { id: key } : { slug: key }), status: 'active' },
        include: storeInclude(now),
      });
      if (!m) throw new AppError('NOT_FOUND', 'Store not found');
      const { lat, lng } = req.query;
      let distance: number | null = null;
      if (lat !== undefined && lng !== undefined) {
        const [row] = await app.db.$queryRaw<{ d: number | null }[]>`
          SELECT ${distanceTo(lat, lng)} AS d FROM merchants m WHERE m.id = ${m.id}::uuid`;
        distance = row?.d ?? null;
      }
      let delivery = null;
      if (distance !== null && m.zoneId) {
        const { zone, prep } = await loadBrowsePricing(app.db, m.zoneId, [m.id], now);
        if (zone) delivery = estimateStoreDelivery(zone, m, distance, prep.get(m.id));
      }
      const today = manilaDateKey(now);
      return {
        ...toSummary(m, distance, now, delivery),
        description: m.description,
        addressLine: m.addressLine,
        barangay: m.barangay,
        city: m.city,
        location: { lat: m.lat, lng: m.lng },
        pauseMessage: m.pauseMessage,
        deliveryRadiusM: m.deliveryRadiusM,
        advanceOrderHours: m.advanceOrderHours,
        avgResponseSeconds: m.avgResponseSeconds,
        followerCount: m._count.followers,
        tags: m.tags.map((t) => t.tag),
        weekly: m.storeHours.map((h) => ({
          dayOfWeek: h.dayOfWeek,
          opensAt: h.opensAt,
          closesAt: h.closesAt,
        })),
        holidays: m.holidayClosures.map(holidayOf).filter((h) => h.date >= today),
      };
    },
  );

  r.get(
    '/:merchantId/categories',
    {
      schema: {
        tags,
        summary: 'Menu categories with something visible right now',
        params: storeParams,
        querystring: cursorPageQuerySchema,
        response: { 200: cursorPageSchema(publicCategorySchema) },
      },
    },
    async (req) => {
      const { merchantId } = req.params;
      const now = new Date();
      await assertActiveStore(app.db, merchantId);
      const [categories, products, schedulesOf] = await Promise.all([
        app.db.category.findMany({
          where: { merchantId, isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        }),
        app.db.product.findMany({
          where: { ...liveProductWhere(merchantId), categoryId: { not: null } },
          select: { id: true, categoryId: true },
        }),
        cachedSchedules(app.db, app.redis, [merchantId], req.log),
      ]);
      const counts = new Map<string, number>();
      for (const p of products) {
        if (p.categoryId && isVisibleOnMenu(p, schedulesOf(merchantId), now)) {
          counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
        }
      }
      // Small, bounded list per store: filter in memory, then page by id.
      const visible: PublicCategory[] = categories
        .filter((c) => counts.has(c.id))
        .map((c) => ({
          id: c.id,
          name: c.name,
          sortOrder: c.sortOrder,
          productCount: counts.get(c.id) ?? 0,
        }));
      const after = idCursor(req.query.cursor);
      const start = after ? visible.findIndex((c) => c.id === after) + 1 : 0;
      const items = visible.slice(start, start + req.query.limit);
      const hasMore = start + req.query.limit < visible.length;
      return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
    },
  );

  r.get(
    '/:merchantId/products',
    {
      schema: {
        tags,
        summary: 'Menu items visible right now',
        params: storeParams,
        querystring: storeProductsQuerySchema,
        response: { 200: cursorPageSchema(productCardSchema) },
      },
    },
    async (req) => {
      const { merchantId } = req.params;
      const q = req.query;
      const now = new Date();
      await assertActiveStore(app.db, merchantId);
      const schedulesOf = await cachedSchedules(app.db, app.redis, [merchantId], req.log);
      const where: Prisma.ProductWhereInput = {
        AND: [
          liveProductWhere(merchantId),
          q.categoryId ? { categoryId: q.categoryId } : {},
          q.q
            ? {
                OR: [
                  { name: { contains: q.q, mode: 'insensitive' } },
                  { description: { contains: q.q, mode: 'insensitive' } },
                ],
              }
            : {},
          q.dietary?.length ? { dietaryTags: { hasSome: q.dietary } } : {},
          q.budget ? { basePriceCentavos: { lte: BigInt(BUDGET_PRICE_CENTAVOS) } } : {},
        ],
      };
      const page = await scanPage<
        Awaited<ReturnType<typeof fetchProducts>>[number],
        ProductCard,
        string
      >({
        start: idCursor(q.cursor),
        limit: q.limit,
        fetch: (after, take) => fetchProducts(app.db, where, after, take),
        keyOf: (p) => p.id,
        map: async (rows) =>
          rows.map((p) => {
            if (!isVisibleOnMenu(p, schedulesOf(merchantId), now)) return null;
            const card = toCard(p);
            return q.inStock && card.isSoldOut ? null : card;
          }),
      });
      return { items: page.items, nextCursor: page.next };
    },
  );

  r.get(
    '/:merchantId/products/:productId',
    {
      schema: {
        tags,
        summary: 'Product detail (variants, options)',
        params: productParams,
        response: { 200: publicProductSchema },
      },
    },
    async (req) => {
      const { merchantId, productId } = req.params;
      await assertActiveStore(app.db, merchantId);
      const [p, schedulesOf] = await Promise.all([
        app.db.product.findFirst({
          where: { ...liveProductWhere(merchantId), id: productId },
          include: productInclude,
        }),
        cachedSchedules(app.db, app.redis, [merchantId], req.log),
      ]);
      if (!p || !isVisibleOnMenu(p, schedulesOf(merchantId), new Date())) {
        throw new AppError('NOT_FOUND', 'Product not found');
      }
      return toPublicProduct(p);
    },
  );
}

function fetchProducts(
  db: Db,
  where: Prisma.ProductWhereInput,
  after: string | null,
  take: number,
) {
  return db.product.findMany({
    where,
    include: productInclude,
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    take,
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
  });
}
