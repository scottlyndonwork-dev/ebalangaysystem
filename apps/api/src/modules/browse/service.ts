import {
  BUDGET_PRICE_CENTAVOS,
  type ClosedReason,
  type DietaryTag,
  type MerchantSummary,
  type ProductCard,
  type PublicProduct,
} from '@ebalangay/shared';
import { z } from 'zod';
import type { Db, Tx } from '../../db.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { type ProductRow, toProduct } from '../catalog/service.js';
import { availabilityOf, profileInclude, type MerchantWithProfile } from '../merchants/service.js';

// ------------------------------------------------------------------ cursors

/** Keyset position: rows are ordered by (sortKey asc, id asc). */
export interface Keyset {
  k: number;
  id: string;
}
const keysetSchema = z.object({ k: z.number(), id: z.uuid() });

export const encodeKeyset = (c: Keyset): string =>
  Buffer.from(JSON.stringify(c)).toString('base64url');

export function decodeKeyset(cursor: string | undefined): Keyset | null {
  if (!cursor) return null;
  try {
    return keysetSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Invalid cursor');
  }
}

const MAX_SCAN_ROUNDS = 5;

/**
 * Keyset pagination when some rows are dropped after the query (opening hours, menu schedules
 * are evaluated in TS). Scans batches until the page is full; if the scan budget runs out the
 * page may be short, but `next` still points past every row scanned, so nothing is skipped.
 */
export async function scanPage<R, T, K>(opts: {
  start: K | null;
  limit: number;
  fetch: (after: K | null, take: number) => Promise<R[]>;
  keyOf: (row: R) => K;
  /** Same length as rows; null = drop. */
  map: (rows: R[]) => Promise<(T | null)[]>;
}): Promise<{ items: T[]; next: K | null }> {
  const take = Math.max(opts.limit * 2, 40);
  const items: T[] = [];
  let lastKept: K | null = null;
  let after = opts.start;
  for (let round = 0; round < MAX_SCAN_ROUNDS; round++) {
    const rows = await opts.fetch(after, take);
    const mapped = await opts.map(rows);
    for (const [i, row] of rows.entries()) {
      const item = mapped[i];
      if (item === null || item === undefined) continue;
      if (items.length === opts.limit) return { items, next: lastKept };
      items.push(item);
      lastKept = opts.keyOf(row);
    }
    const last = rows.at(-1);
    if (rows.length < take || !last) return { items, next: null };
    after = opts.keyOf(last);
  }
  return { items, next: after };
}

// ------------------------------------------------------------------ geo

/** The active zone covering the customer's point (oldest wins on overlap, like assignZone). */
export async function zoneAt(db: Db | Tx, lat: number, lng: number): Promise<string | null> {
  const [row] = await db.$queryRaw<{ id: string }[]>`
    SELECT z.id FROM zones z
    WHERE z.is_active AND z.polygon IS NOT NULL AND ST_Covers(z.polygon, eb_point(${lat}::float8, ${lng}::float8))
    ORDER BY z.created_at LIMIT 1`;
  return row?.id ?? null;
}

/** Stores that deliver to the point: active, same zone, point inside the store's delivery radius. */
export const deliversTo = (zoneId: string, lat: number, lng: number) => Prisma.sql`
  m.status = 'active' AND m.zone_id = ${zoneId}::uuid AND m.location IS NOT NULL
  AND ST_DWithin(m.location, eb_point(${lat}::float8, ${lng}::float8), m.delivery_radius_m)`;

/** Pre-filter for "open now"; opening hours are evaluated per row in TS. */
export const notPaused = Prisma.sql`m.auto_paused_reason IS NULL
  AND (m.paused_until IS NULL OR m.paused_until <= now())`;

export const distanceTo = (lat: number, lng: number) =>
  Prisma.sql`ST_Distance(m.location, eb_point(${lat}::float8, ${lng}::float8))`;

// ------------------------------------------------------------------ text search

/** Word-similarity cutoff for typo tolerance ("adbo" → "Adobo"); pg_trgm's default is 0.6. */
const WORD_SIMILARITY = '0.4';

/** Run search queries with the looser trigram threshold (transaction-local). */
export async function withTrigramSearch<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('pg_trgm.word_similarity_threshold', ${WORD_SIMILARITY}, true)`;
    return fn(tx);
  });
}

/** "chicken ado" → "chicken:* & ado:*" (prefix match); null when nothing searchable is left. */
export function prefixTsQuery(q: string): string | null {
  const words =
    q
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.slice(0, 6) ?? [];
  return words.length ? words.map((w) => `${w}:*`).join(' & ') : null;
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** FTS (prefix) or typo-tolerant trigram match on product name/description. */
export function productMatches(q: string, alias = 'p'): Prisma.Sql {
  const p = Prisma.raw(alias);
  const tsq = prefixTsQuery(q);
  const fts = tsq ? Prisma.sql`${p}.search_tsv @@ to_tsquery('simple', ${tsq}) OR ` : Prisma.empty;
  return Prisma.sql`(${fts}${q}::text <% ${p}.name OR ${p}.name ILIKE ${likePattern(q)})`;
}

/** Higher = better. Only meaningful alongside productMatches. */
export function productScore(q: string, alias = 'p'): Prisma.Sql {
  const p = Prisma.raw(alias);
  const tsq = prefixTsQuery(q);
  const rank = tsq
    ? Prisma.sql`ts_rank(${p}.search_tsv, to_tsquery('simple', ${tsq}))`
    : Prisma.sql`0`;
  return Prisma.sql`(${rank} + word_similarity(${q}::text, ${p}.name))`;
}

export const storeNameMatches = (q: string) =>
  Prisma.sql`(${q}::text <% m.name OR m.name ILIKE ${likePattern(q)})`;

/** The product has something to sell right now (untracked, or stock left on it / a variant). */
export const inStockSql = (alias = 'p') => {
  const p = Prisma.raw(alias);
  return Prisma.sql`(NOT ${p}.track_inventory OR EXISTS (
    SELECT 1 FROM inventory_levels il LEFT JOIN variants v ON v.id = il.variant_id
    WHERE il.product_id = ${p}.id AND il.quantity > 0 AND (il.variant_id IS NULL OR v.is_available)))`;
};

export interface ProductFilters {
  dietary?: DietaryTag[] | undefined;
  budget?: boolean | undefined;
  inStock?: boolean | undefined;
}

/** Live, orderable product conditions + optional filters, for alias `p`. */
export function productConditions(f: ProductFilters, q?: string): Prisma.Sql {
  const parts = [Prisma.sql`p.deleted_at IS NULL AND p.is_available`];
  if (f.dietary?.length) parts.push(Prisma.sql`p.dietary_tags && ${f.dietary}::text[]`);
  if (f.budget) parts.push(Prisma.sql`p.base_price_centavos <= ${BUDGET_PRICE_CENTAVOS}`);
  if (f.inStock) parts.push(inStockSql());
  if (q) parts.push(productMatches(q));
  return Prisma.join(parts, ' AND ');
}

export const hasProductFilters = (f: ProductFilters) =>
  Boolean(f.dietary?.length || f.budget || f.inStock);

// ------------------------------------------------------------------ store loading + mapping

/** Hours/holidays (for availability) plus what the store page shows. */
export function storeInclude(now = new Date()) {
  return {
    ...profileInclude(now),
    tags: { include: { tag: { select: { slug: true, name: true } } } },
  } satisfies Prisma.MerchantInclude;
}
export type StoreRow = Prisma.MerchantGetPayload<{ include: ReturnType<typeof storeInclude> }>;

export async function loadStores(db: Db | Tx, ids: string[], now = new Date()) {
  if (!ids.length) return new Map<string, StoreRow>();
  const rows = await db.merchant.findMany({
    where: { id: { in: ids } },
    include: storeInclude(now),
  });
  return new Map(rows.map((m) => [m.id, m]));
}

export function toSummary(
  m: MerchantWithProfile,
  distanceMeters: number | null,
  now = new Date(),
): MerchantSummary {
  const a = availabilityOf(m, now);
  return {
    id: m.id,
    slug: m.slug,
    name: m.name,
    businessType: m.businessType,
    logoUrl: m.logoUrl,
    coverUrl: m.coverUrl,
    ratingAverage: Number(m.ratingAverage),
    ratingCount: m.ratingCount,
    isOpen: a.isOpen,
    closedReason: a.closedReason as ClosedReason | null,
    closesInMinutes: a.closesInMinutes,
    prepTimeMinutes: m.prepTimeMinutes,
    minOrderCentavos: Number(m.minOrderCentavos),
    verifiedBadge: m.verifiedBadge,
    freeDelivery: m.freeDelivery,
    distanceMeters: distanceMeters === null ? null : Math.round(distanceMeters),
    deliveryFeeCentavos: null,
    etaMinutes: null,
  };
}

// ------------------------------------------------------------------ products

/** Active menu schedules per merchant. */
export async function loadSchedules(db: Db | Tx, merchantIds: string[]) {
  const rows = merchantIds.length
    ? await db.menuSchedule.findMany({
        where: { merchantId: { in: merchantIds }, isActive: true },
      })
    : [];
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.merchantId, [...(by.get(r.merchantId) ?? []), r]);
  return (merchantId: string) => by.get(merchantId) ?? [];
}

export function toPublicProduct(row: ProductRow): PublicProduct {
  const p = toProduct(row);
  const isLowStock = p.stock ? p.stock.isLow && !p.stock.isSoldOut : false;
  return {
    id: p.id,
    merchantId: p.merchantId,
    categoryId: p.categoryId,
    name: p.name,
    description: p.description,
    images: p.images,
    basePriceCentavos: p.basePriceCentavos,
    compareAtPriceCentavos: p.compareAtPriceCentavos,
    dietaryTags: p.dietaryTags,
    isSoldOut: p.isSoldOut,
    isLowStock:
      isLowStock || p.variants.some((v) => v.isAvailable && v.stock?.isLow && !v.stock.isSoldOut),
    variants: p.variants.map((v) => ({
      id: v.id,
      name: v.name,
      priceCentavos: v.priceCentavos,
      isAvailable: v.isAvailable,
      isSoldOut: v.stock?.isSoldOut ?? false,
      isLowStock: v.stock ? v.stock.isLow && !v.stock.isSoldOut : false,
    })),
    modifierGroups: p.modifierGroups,
    wholesaleTiers: p.wholesaleTiers,
  };
}

export function toCard(row: ProductRow): ProductCard {
  const p = toPublicProduct(row);
  const prices = p.variants
    .filter((v) => v.isAvailable && !v.isSoldOut)
    .map((v) => v.priceCentavos);
  return {
    id: p.id,
    merchantId: p.merchantId,
    categoryId: p.categoryId,
    name: p.name,
    description: p.description,
    imageUrl: p.images[0]?.thumbUrl ?? null,
    fromPriceCentavos: prices.length ? Math.min(...prices) : p.basePriceCentavos,
    compareAtPriceCentavos: p.compareAtPriceCentavos,
    dietaryTags: p.dietaryTags,
    isSoldOut: p.isSoldOut,
    isLowStock: p.isLowStock,
    hasOptions: p.variants.length > 0 || p.modifierGroups.length > 0,
  };
}
