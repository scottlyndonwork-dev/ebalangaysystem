import type { DietaryTag, Product, StockLevel } from '@ebalangay/shared';
import type { Tx } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';

export const KEY_PRODUCT_SOLD_OUT = 'key_product_sold_out';

export const productInclude = {
  images: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  variants: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  modifierGroups: {
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { modifiers: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
  },
  wholesalePrices: { orderBy: [{ minQty: 'asc' }, { id: 'asc' }] },
  inventoryLevels: true,
} satisfies Prisma.ProductInclude;

export type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type LevelRow = ProductRow['inventoryLevels'][number];

/** Untracked → null. */
export function stockOf(
  trackInventory: boolean,
  level: Pick<LevelRow, 'quantity' | 'lowStockThreshold'> | undefined,
): StockLevel | null {
  return trackInventory ? levelOf(level) : null;
}

/** No row yet → 0 (sold out until stocked). */
export function levelOf(
  level: Pick<LevelRow, 'quantity' | 'lowStockThreshold'> | undefined,
): StockLevel {
  const quantity = level?.quantity ?? 0;
  const lowStockThreshold = level?.lowStockThreshold ?? 5;
  return {
    quantity,
    lowStockThreshold,
    isLow: quantity <= lowStockThreshold,
    isSoldOut: quantity === 0,
  };
}

export function toProduct(p: ProductRow): Product {
  const levelFor = (variantId: string | null) =>
    p.inventoryLevels.find((l) => l.variantId === variantId);
  const variants = p.variants.map((v) => ({
    id: v.id,
    productId: p.id,
    name: v.name,
    priceCentavos: Number(v.priceCentavos),
    sku: v.sku,
    isAvailable: v.isAvailable,
    sortOrder: v.sortOrder,
    stock: stockOf(p.trackInventory, levelFor(v.id)),
  }));
  const stock = variants.length ? null : stockOf(p.trackInventory, levelFor(null));
  const isSoldOut = !p.trackInventory
    ? false
    : variants.length
      ? variants.every((v) => !v.isAvailable || v.stock?.isSoldOut)
      : (stock?.isSoldOut ?? false);
  return {
    id: p.id,
    merchantId: p.merchantId,
    categoryId: p.categoryId,
    name: p.name,
    description: p.description,
    images: p.images.map((i) => ({
      id: i.id,
      url: i.url,
      thumbUrl: i.thumbUrl ?? i.url,
      displayUrl: i.displayUrl ?? i.url,
      sortOrder: i.sortOrder,
    })),
    basePriceCentavos: Number(p.basePriceCentavos),
    compareAtPriceCentavos:
      p.compareAtPriceCentavos === null ? null : Number(p.compareAtPriceCentavos),
    sku: p.sku,
    isAvailable: p.isAvailable,
    isKey: p.isKey,
    dietaryTags: p.dietaryTags as DietaryTag[],
    trackInventory: p.trackInventory,
    stock,
    isSoldOut,
    variants,
    modifierGroups: p.modifierGroups.map((g) => ({
      id: g.id,
      name: g.name,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      options: g.modifiers.map((m) => ({
        id: m.id,
        name: m.name,
        priceDeltaCentavos: Number(m.priceDeltaCentavos),
        isAvailable: m.isAvailable,
      })),
    })),
    wholesaleTiers: p.wholesalePrices.map((w) => ({
      variantId: w.variantId,
      minQuantity: w.minQty,
      unitPriceCentavos: Number(w.unitPriceCentavos),
    })),
    sortOrder: p.sortOrder,
    version: p.version,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** A live (not deleted) product of this merchant, or 404. Callers run inside withMerchantContext. */
export async function loadProduct(tx: Tx, merchantId: string, productId: string) {
  const p = await tx.product.findFirst({
    where: { id: productId, merchantId, deletedAt: null },
    include: productInclude,
  });
  if (!p) throw new AppError('NOT_FOUND', 'Product not found');
  return p;
}

export async function assertCategory(tx: Tx, merchantId: string, categoryId: string | null) {
  if (!categoryId) return;
  const c = await tx.category.findFirst({
    where: { id: categoryId, merchantId },
    select: { id: true },
  });
  if (!c) throw new AppError('VALIDATION_FAILED', 'Unknown category', { field: 'categoryId' });
}

/**
 * Set stock for one product/variant and log the movement. Row-locked so concurrent adjustments
 * (merchant + orders) serialise. Returns the new quantity.
 */
export async function changeStock(
  tx: Tx,
  input: {
    merchantId: string;
    productId: string;
    variantId: string | null;
    mode: 'set' | 'adjust';
    quantity: number;
    reason: string;
    note?: string | null;
    orderId?: string | null;
    actorUserId?: string | null;
    lowStockThreshold?: number;
  },
): Promise<number> {
  const { merchantId, productId, variantId } = input;
  const rows = await tx.$queryRaw<{ id: string; quantity: number }[]>`
    SELECT id, quantity FROM inventory_levels
    WHERE product_id = ${productId}::uuid
      AND variant_id IS NOT DISTINCT FROM ${variantId}::uuid
    FOR UPDATE`;
  const current = rows[0];
  const before = current?.quantity ?? 0;
  const after = input.mode === 'set' ? input.quantity : before + input.quantity;
  if (after < 0) {
    throw new AppError('OUT_OF_STOCK', `Only ${before} left in stock`, { available: before });
  }
  const threshold =
    input.lowStockThreshold !== undefined ? { lowStockThreshold: input.lowStockThreshold } : {};
  if (current) {
    await tx.inventoryLevel.update({
      where: { id: current.id },
      data: { quantity: after, ...threshold },
    });
  } else {
    await tx.inventoryLevel.create({
      data: { merchantId, productId, variantId, quantity: after, ...threshold },
    });
  }
  const delta = after - before;
  if (delta !== 0) {
    await tx.inventoryMovement.create({
      data: {
        merchantId,
        productId,
        variantId,
        delta,
        reason: input.reason,
        note: input.note ?? null,
        orderId: input.orderId ?? null,
        actorUserId: input.actorUserId ?? null,
      },
    });
  }
  return after;
}

/**
 * Auto-pause the store while any key product is sold out; lift only our own auto-pause once
 * every key product is back in stock. Call after any stock or key-product change.
 */
export async function syncKeyProductAutoPause(tx: Tx, merchantId: string): Promise<void> {
  const [row] = await tx.$queryRaw<{ sold_out: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM products p
      WHERE p.merchant_id = ${merchantId}::uuid
        AND p.is_key AND p.track_inventory AND p.is_available AND p.deleted_at IS NULL
        AND CASE
          WHEN EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id) THEN NOT EXISTS (
            SELECT 1 FROM variants v
            JOIN inventory_levels il ON il.variant_id = v.id
            WHERE v.product_id = p.id AND v.is_available AND il.quantity > 0)
          ELSE NOT EXISTS (
            SELECT 1 FROM inventory_levels il
            WHERE il.product_id = p.id AND il.variant_id IS NULL AND il.quantity > 0)
        END
    ) AS sold_out`;
  const soldOut = row?.sold_out ?? false;
  if (soldOut) {
    await tx.merchant.updateMany({
      where: { id: merchantId, autoPausedReason: null },
      data: {
        autoPausedReason: KEY_PRODUCT_SOLD_OUT,
        autoPausedAt: new Date(),
        version: { increment: 1 },
      },
    });
  } else {
    await tx.merchant.updateMany({
      where: { id: merchantId, autoPausedReason: KEY_PRODUCT_SOLD_OUT },
      data: { autoPausedReason: null, autoPausedAt: null, version: { increment: 1 } },
    });
  }
}

/** Prisma cursor page over a unique id with a stable order. */
export function pageOf<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}

export const cursorArgs = (
  cursor: string | undefined,
): { cursor?: { id: string }; skip?: number } =>
  cursor ? { cursor: { id: cursor }, skip: 1 } : {};
