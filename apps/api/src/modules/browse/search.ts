import {
  isVisibleOnMenu,
  MAX_SUGGESTIONS,
  type ProductHit,
  searchProductsQuerySchema,
  searchProductsResultSchema,
  suggestionsSchema,
  suggestQuerySchema,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '../../generated/prisma/client.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { productInclude } from '../catalog/service.js';
import {
  type Keyset,
  decodeKeyset,
  deliversTo,
  distanceTo,
  encodeKeyset,
  loadStores,
  notPaused,
  productConditions,
  productScore,
  scanPage,
  storeNameMatches,
  toCard,
  toSummary,
  withTrigramSearch,
  zoneAt,
} from './service.js';
import { cachedSchedules } from '../catalog/menu-cache.js';

const tags = ['browse'];

interface ProductHitRow {
  id: string;
  merchant_id: string;
  distance_m: number;
  sort_key: number;
}

/** /v1/search/* — public product search (FTS + typo-tolerant trigram) and autocomplete. */
export async function searchRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/products',
    {
      schema: {
        tags,
        summary: 'Search items sold by stores that deliver to the given point',
        querystring: searchProductsQuerySchema,
        response: { 200: searchProductsResultSchema },
      },
    },
    async (req) => {
      const q = req.query;
      const now = new Date();
      const zoneId = await zoneAt(app.db, q.lat, q.lng);
      if (!zoneId) return { items: [], nextCursor: null, zoneId: null };

      const where = [
        deliversTo(zoneId, q.lat, q.lng),
        Prisma.sql`(c.id IS NULL OR c.is_active)`,
        productConditions(q, q.q),
      ];
      if (q.openNow) where.push(notPaused);

      const page = await withTrigramSearch(app.db, (tx) =>
        scanPage<ProductHitRow, ProductHit, Keyset>({
          start: decodeKeyset(q.cursor),
          limit: q.limit,
          // Best match first: sort_key = -score.
          fetch: (after, take) => tx.$queryRaw<ProductHitRow[]>`
            SELECT * FROM (
              SELECT p.id, p.merchant_id, ${distanceTo(q.lat, q.lng)} AS distance_m,
                (-${productScore(q.q)})::float8 AS sort_key
              FROM products p
              JOIN merchants m ON m.id = p.merchant_id
              LEFT JOIN categories c ON c.id = p.category_id
              WHERE ${Prisma.join(where, ' AND ')}
            ) s
            ${after ? Prisma.sql`WHERE (s.sort_key, s.id) > (${after.k}::float8, ${after.id}::uuid)` : Prisma.empty}
            ORDER BY s.sort_key, s.id LIMIT ${take}::int`,
          keyOf: (row) => ({ k: row.sort_key, id: row.id }),
          map: async (rows) => {
            const merchantIds = [...new Set(rows.map((row) => row.merchant_id))];
            // Sequential: one connection inside the transaction.
            const products = await tx.product.findMany({
              where: { id: { in: rows.map((row) => row.id) } },
              include: productInclude,
            });
            const stores = await loadStores(tx, merchantIds, now);
            const schedulesOf = await cachedSchedules(tx, app.redis, merchantIds, req.log);
            const byId = new Map(products.map((p) => [p.id, p]));
            return rows.map((row) => {
              const p = byId.get(row.id);
              const m = stores.get(row.merchant_id);
              if (!p || !m || !isVisibleOnMenu(p, schedulesOf(m.id), now)) return null;
              const s = toSummary(m, row.distance_m, now);
              if (q.openNow && !s.isOpen) return null;
              return {
                product: toCard(p),
                store: {
                  id: s.id,
                  slug: s.slug,
                  name: s.name,
                  logoUrl: s.logoUrl,
                  isOpen: s.isOpen,
                  distanceMeters: s.distanceMeters ?? 0,
                },
              };
            });
          },
        }),
      );
      return {
        items: page.items,
        nextCursor: page.next ? encodeKeyset(page.next) : null,
        zoneId,
      };
    },
  );

  r.get(
    '/suggest',
    {
      schema: {
        tags,
        summary: 'Autocomplete: matching store names and item names nearby',
        querystring: suggestQuerySchema,
        response: { 200: suggestionsSchema },
      },
    },
    async (req) => {
      const { q, lat, lng } = req.query;
      const zoneId = await zoneAt(app.db, lat, lng);
      if (!zoneId) return { stores: [], products: [] };
      const near = deliversTo(zoneId, lat, lng);
      return withTrigramSearch(app.db, async (tx) => {
        const stores = await tx.$queryRaw<
          { id: string; slug: string; name: string; logo_url: string | null }[]
        >`
            SELECT m.id, m.slug, m.name, m.logo_url FROM merchants m
            WHERE ${near} AND ${storeNameMatches(q)}
            ORDER BY word_similarity(${q}::text, m.name) DESC, m.name, m.id
            LIMIT ${MAX_SUGGESTIONS}::int`;
        const products = await tx.$queryRaw<{ name: string }[]>`
            SELECT min(p.name) AS name FROM products p
            JOIN merchants m ON m.id = p.merchant_id
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE ${near} AND (c.id IS NULL OR c.is_active) AND ${productConditions({}, q)}
            GROUP BY lower(p.name)
            ORDER BY max(${productScore(q)}) DESC, lower(p.name)
            LIMIT ${MAX_SUGGESTIONS}::int`;
        return {
          stores: stores.map((s) => ({
            id: s.id,
            slug: s.slug,
            name: s.name,
            logoUrl: s.logo_url,
          })),
          products: products.map((p) => p.name),
        };
      });
    },
  );
}
