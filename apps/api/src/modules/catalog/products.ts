import {
  WHOLESALE_BUSINESS_TYPES,
  type BusinessType,
  createProductInputSchema,
  cursorPageSchema,
  listProductsQuerySchema,
  productSchema,
  reorderInputSchema,
  updateProductInputSchema,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Tx, withMerchantContext } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { authOf, requireMerchantPermission } from '../../plugins/auth.js';
import {
  assertCategory,
  changeStock,
  cursorArgs,
  loadProduct,
  pageOf,
  productInclude,
  syncKeyProductAutoPause,
  toProduct,
} from './service.js';

const tags = ['catalog'];
const params = z.object({ merchantId: z.uuid() });
const productParams = params.extend({ productId: z.uuid() });

type CreateInput = z.output<typeof createProductInputSchema>;
type UpdateInput = z.output<typeof updateProductInputSchema>;
type VariantInput = NonNullable<UpdateInput['variants']>[number] & { initialStock?: number };
type GroupInput = CreateInput['modifierGroups'][number];
type TierInput = CreateInput['wholesaleTiers'][number];

async function assertWholesaleAllowed(tx: Tx, merchantId: string, tiers: TierInput[] | undefined) {
  if (!tiers?.length) return;
  const m = await tx.merchant.findUnique({
    where: { id: merchantId },
    select: { businessType: true },
  });
  if (!m || !WHOLESALE_BUSINESS_TYPES.includes(m.businessType as BusinessType)) {
    throw new AppError('FORBIDDEN', 'Wholesale prices are for suppliers and wholesalers only');
  }
}

function assertTierIndexes(tiers: TierInput[] | undefined, variantCount: number) {
  for (const t of tiers ?? []) {
    if (t.variantIndex !== null && t.variantIndex >= variantCount) {
      throw new AppError('VALIDATION_FAILED', 'Wholesale tier points at a missing variant', {
        field: 'wholesaleTiers',
      });
    }
  }
}

/** Variants by id must already belong to this product; returns the variants' ids in order. */
async function syncVariants(tx: Tx, productId: string, input: VariantInput[]): Promise<string[]> {
  const existing = await tx.variant.findMany({ where: { productId }, select: { id: true } });
  const known = new Set(existing.map((v) => v.id));
  for (const v of input) {
    if (v.id && !known.has(v.id)) throw new AppError('VALIDATION_FAILED', 'Unknown variant');
  }
  const keep = input.flatMap((v) => (v.id ? [v.id] : []));
  await tx.variant.deleteMany({ where: { productId, id: { notIn: keep } } });
  const ids: string[] = [];
  for (const [sortOrder, v] of input.entries()) {
    const data = {
      name: v.name,
      priceCentavos: BigInt(v.priceCentavos),
      sku: v.sku,
      isAvailable: v.isAvailable,
      sortOrder,
    };
    const row = v.id
      ? await tx.variant.update({ where: { id: v.id }, data })
      : await tx.variant.create({ data: { ...data, productId } });
    ids.push(row.id);
  }
  return ids;
}

async function syncModifierGroups(tx: Tx, productId: string, input: GroupInput[]) {
  const existing = await tx.modifierGroup.findMany({
    where: { productId },
    select: { id: true, modifiers: { select: { id: true } } },
  });
  const groups = new Map(existing.map((g) => [g.id, new Set(g.modifiers.map((m) => m.id))]));
  for (const g of input) {
    if (g.id && !groups.has(g.id))
      throw new AppError('VALIDATION_FAILED', 'Unknown modifier group');
    const opts = g.id ? groups.get(g.id) : new Set<string>();
    for (const o of g.options) {
      if (o.id && !opts?.has(o.id)) throw new AppError('VALIDATION_FAILED', 'Unknown modifier');
    }
  }
  const keep = input.flatMap((g) => (g.id ? [g.id] : []));
  await tx.modifierGroup.deleteMany({ where: { productId, id: { notIn: keep } } });
  for (const [sortOrder, g] of input.entries()) {
    const data = { name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, sortOrder };
    const group = g.id
      ? await tx.modifierGroup.update({ where: { id: g.id }, data })
      : await tx.modifierGroup.create({ data: { ...data, productId } });
    const keepOpts = g.options.flatMap((o) => (o.id ? [o.id] : []));
    await tx.modifier.deleteMany({ where: { groupId: group.id, id: { notIn: keepOpts } } });
    for (const [optOrder, o] of g.options.entries()) {
      const od = {
        name: o.name,
        priceDeltaCentavos: BigInt(o.priceDeltaCentavos),
        isAvailable: o.isAvailable,
        sortOrder: optOrder,
      };
      if (o.id) await tx.modifier.update({ where: { id: o.id }, data: od });
      else await tx.modifier.create({ data: { ...od, groupId: group.id } });
    }
  }
}

async function replaceTiers(tx: Tx, productId: string, tiers: TierInput[], variantIds: string[]) {
  await tx.wholesalePrice.deleteMany({ where: { productId } });
  if (!tiers.length) return;
  await tx.wholesalePrice.createMany({
    data: tiers.map((t) => ({
      productId,
      variantId: t.variantIndex === null ? null : (variantIds[t.variantIndex] ?? null),
      minQty: t.minQuantity,
      unitPriceCentavos: BigInt(t.unitPriceCentavos),
    })),
  });
}

/**
 * Tracked products always have one level row per stock unit (the product, or each variant),
 * so inventory lists and the key-product check never miss a unit. Stale rows are removed.
 */
export async function ensureLevels(tx: Tx, merchantId: string, productId: string) {
  const p = await tx.product.findUniqueOrThrow({
    where: { id: productId },
    select: { trackInventory: true, variants: { select: { id: true } } },
  });
  if (!p.trackInventory) return;
  const units = p.variants.length ? p.variants.map((v) => v.id) : [null];
  if (p.variants.length) {
    await tx.inventoryLevel.deleteMany({ where: { productId, variantId: null } });
  }
  const have = await tx.inventoryLevel.findMany({
    where: { productId },
    select: { variantId: true },
  });
  const present = new Set(have.map((l) => l.variantId));
  const missing = units.filter((u) => !present.has(u));
  if (missing.length) {
    await tx.inventoryLevel.createMany({
      data: missing.map((variantId) => ({ merchantId, productId, variantId, quantity: 0 })),
    });
  }
}

async function reorder(
  tx: Tx,
  model: 'product' | 'category',
  merchantId: string,
  ids: string[],
): Promise<void> {
  const where = { id: { in: ids }, merchantId };
  const found =
    model === 'product'
      ? await tx.product.count({ where: { ...where, deletedAt: null } })
      : await tx.category.count({ where });
  if (found !== ids.length) throw new AppError('VALIDATION_FAILED', `Unknown ${model} in list`);
  for (const [sortOrder, id] of ids.entries()) {
    if (model === 'product') await tx.product.update({ where: { id }, data: { sortOrder } });
    else await tx.category.update({ where: { id }, data: { sortOrder } });
  }
}

export { reorder };

export async function productRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/:merchantId/products',
    {
      schema: {
        tags,
        params,
        querystring: listProductsQuerySchema,
        response: { 200: cursorPageSchema(productSchema) },
      },
      preHandler: requireMerchantPermission(),
    },
    async (req) => {
      const { merchantId } = req.params;
      const { cursor, limit, categoryId, q, available } = req.query;
      return withMerchantContext(app.db, merchantId, async (tx) => {
        const rows = await tx.product.findMany({
          where: {
            merchantId,
            deletedAt: null,
            ...(categoryId ? { categoryId } : {}),
            ...(available !== undefined ? { isAvailable: available } : {}),
            ...(q
              ? {
                  OR: [
                    { name: { contains: q, mode: 'insensitive' } },
                    { sku: { equals: q, mode: 'insensitive' } },
                  ],
                }
              : {}),
          },
          include: productInclude,
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          take: limit + 1,
          ...cursorArgs(cursor),
        });
        const page = pageOf(rows, limit);
        return { items: page.items.map(toProduct), nextCursor: page.nextCursor };
      });
    },
  );

  r.get(
    '/:merchantId/products/:productId',
    {
      schema: { tags, params: productParams, response: { 200: productSchema } },
      preHandler: requireMerchantPermission(),
    },
    async (req) => {
      const { merchantId, productId } = req.params;
      return withMerchantContext(app.db, merchantId, async (tx) =>
        toProduct(await loadProduct(tx, merchantId, productId)),
      );
    },
  );

  r.post(
    '/:merchantId/products',
    {
      schema: { tags, params, body: createProductInputSchema, response: { 201: productSchema } },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req, reply) => {
      const { merchantId } = req.params;
      const { variants, modifierGroups, wholesaleTiers, initialStock, ...fields } = req.body;
      if (
        !fields.trackInventory &&
        (initialStock !== undefined || variants.some((v) => v.initialStock !== undefined))
      ) {
        throw new AppError('VALIDATION_FAILED', 'Turn on stock tracking to set opening stock');
      }
      if (variants.length && initialStock !== undefined) {
        throw new AppError('VALIDATION_FAILED', 'Set opening stock per variant', {
          field: 'initialStock',
        });
      }
      assertTierIndexes(wholesaleTiers, variants.length);
      const actorUserId = authOf(req).userId;

      const product = await withMerchantContext(app.db, merchantId, async (tx) => {
        await assertCategory(tx, merchantId, fields.categoryId);
        await assertWholesaleAllowed(tx, merchantId, wholesaleTiers);
        const last = await tx.product.aggregate({
          where: { merchantId, deletedAt: null },
          _max: { sortOrder: true },
        });
        const p = await tx.product.create({
          data: {
            ...fields,
            merchantId,
            basePriceCentavos: BigInt(fields.basePriceCentavos),
            compareAtPriceCentavos:
              fields.compareAtPriceCentavos === null ? null : BigInt(fields.compareAtPriceCentavos),
            sortOrder: (last._max.sortOrder ?? -1) + 1,
          },
        });
        const variantIds = await syncVariants(tx, p.id, variants);
        await syncModifierGroups(tx, p.id, modifierGroups);
        await replaceTiers(tx, p.id, wholesaleTiers, variantIds);
        await ensureLevels(tx, merchantId, p.id);

        const opening = variants.length
          ? variants.map((v, i) => ({ variantId: variantIds[i] ?? null, qty: v.initialStock }))
          : [{ variantId: null, qty: initialStock }];
        for (const { variantId, qty } of opening) {
          if (!qty) continue;
          await changeStock(tx, {
            merchantId,
            productId: p.id,
            variantId,
            mode: 'set',
            quantity: qty,
            reason: 'restock',
            note: 'Opening stock',
            actorUserId,
          });
        }
        await syncKeyProductAutoPause(tx, merchantId);
        return toProduct(await loadProduct(tx, merchantId, p.id));
      });
      return reply.status(201).send(product);
    },
  );

  r.patch(
    '/:merchantId/products/:productId',
    {
      schema: {
        tags,
        params: productParams,
        body: updateProductInputSchema,
        response: { 200: productSchema },
      },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req) => {
      const { merchantId, productId } = req.params;
      const { version, variants, modifierGroups, wholesaleTiers, ...fields } = req.body;

      return withMerchantContext(app.db, merchantId, async (tx) => {
        const current = await loadProduct(tx, merchantId, productId);
        if (fields.categoryId !== undefined)
          await assertCategory(tx, merchantId, fields.categoryId);
        await assertWholesaleAllowed(tx, merchantId, wholesaleTiers);
        assertTierIndexes(wholesaleTiers, variants?.length ?? current.variants.length);

        const { count } = await tx.product.updateMany({
          where: { id: productId, merchantId, version, deletedAt: null },
          data: {
            ...fields,
            ...(fields.basePriceCentavos !== undefined
              ? { basePriceCentavos: BigInt(fields.basePriceCentavos) }
              : {}),
            ...(fields.compareAtPriceCentavos !== undefined
              ? {
                  compareAtPriceCentavos:
                    fields.compareAtPriceCentavos === null
                      ? null
                      : BigInt(fields.compareAtPriceCentavos),
                }
              : {}),
            version: { increment: 1 },
          },
        });
        if (count === 0) {
          throw new AppError('CONFLICT', 'Product was changed by someone else; reload and retry', {
            currentVersion: current.version,
          });
        }
        const variantIds = variants
          ? await syncVariants(tx, productId, variants)
          : current.variants.map((v) => v.id);
        if (modifierGroups) await syncModifierGroups(tx, productId, modifierGroups);
        if (wholesaleTiers) await replaceTiers(tx, productId, wholesaleTiers, variantIds);
        await ensureLevels(tx, merchantId, productId);
        await syncKeyProductAutoPause(tx, merchantId);
        return toProduct(await loadProduct(tx, merchantId, productId));
      });
    },
  );

  /** Soft delete: past orders keep pointing at the product. */
  r.delete(
    '/:merchantId/products/:productId',
    {
      schema: { tags, params: productParams, response: { 204: z.null() } },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req, reply) => {
      const { merchantId, productId } = req.params;
      await withMerchantContext(app.db, merchantId, async (tx) => {
        const { count } = await tx.product.updateMany({
          where: { id: productId, merchantId, deletedAt: null },
          data: { deletedAt: new Date(), isAvailable: false, version: { increment: 1 } },
        });
        if (count === 0) throw new AppError('NOT_FOUND', 'Product not found');
        await tx.cartItem.deleteMany({ where: { productId } });
        await syncKeyProductAutoPause(tx, merchantId);
      });
      return reply.status(204).send(null);
    },
  );

  r.put(
    '/:merchantId/products/order',
    {
      schema: { tags, params, body: reorderInputSchema, response: { 204: z.null() } },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req, reply) => {
      const { merchantId } = req.params;
      await withMerchantContext(app.db, merchantId, (tx) =>
        reorder(tx, 'product', merchantId, req.body.ids),
      );
      return reply.status(204).send(null);
    },
  );
}
