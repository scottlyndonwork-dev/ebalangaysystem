import {
  cursorPageSchema,
  inventoryItemSchema,
  listInventoryQuerySchema,
  listStockMovementsQuerySchema,
  productSchema,
  type StockMovement,
  stockMovementSchema,
  updateStockInputSchema,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withMerchantContext } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { authOf, requireMerchantPermission } from '../../plugins/auth.js';
import {
  changeStock,
  cursorArgs,
  loadProduct,
  pageOf,
  levelOf,
  syncKeyProductAutoPause,
  toProduct,
} from './service.js';

const tags = ['inventory'];
const params = z.object({ merchantId: z.uuid() });
const productParams = params.extend({ productId: z.uuid() });

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Set or adjust stock for a product (or one of its variants). Returns the updated product. */
  r.post(
    '/:merchantId/products/:productId/stock',
    {
      schema: {
        tags,
        params: productParams,
        body: updateStockInputSchema,
        response: { 200: productSchema },
      },
      preHandler: requireMerchantPermission('inventory.edit'),
    },
    async (req) => {
      const { merchantId, productId } = req.params;
      const { variantId, mode, quantity, reason, note, lowStockThreshold } = req.body;
      const actorUserId = authOf(req).userId;
      return withMerchantContext(app.db, merchantId, async (tx) => {
        const p = await loadProduct(tx, merchantId, productId);
        if (!p.trackInventory) {
          throw new AppError('CONFLICT', 'Turn on stock tracking for this product first');
        }
        if (p.variants.length && !variantId) {
          throw new AppError('VALIDATION_FAILED', 'Choose a variant', { field: 'variantId' });
        }
        if (!p.variants.length && variantId) {
          throw new AppError('VALIDATION_FAILED', 'This product has no variants', {
            field: 'variantId',
          });
        }
        if (variantId && !p.variants.some((v) => v.id === variantId)) {
          throw new AppError('NOT_FOUND', 'Variant not found');
        }
        await changeStock(tx, {
          merchantId,
          productId,
          variantId,
          mode,
          quantity,
          reason,
          note,
          actorUserId,
          lowStockThreshold,
        });
        await syncKeyProductAutoPause(tx, merchantId);
        return toProduct(await loadProduct(tx, merchantId, productId));
      });
    },
  );

  r.get(
    '/:merchantId/inventory',
    {
      schema: {
        tags,
        params,
        querystring: listInventoryQuerySchema,
        response: { 200: cursorPageSchema(inventoryItemSchema) },
      },
      preHandler: requireMerchantPermission(),
    },
    async (req) => {
      const { merchantId } = req.params;
      const { cursor, limit, low } = req.query;
      return withMerchantContext(app.db, merchantId, async (tx) => {
        const rows = await tx.inventoryLevel.findMany({
          where: {
            merchantId,
            product: { deletedAt: null, trackInventory: true },
            ...(low ? { quantity: { lte: tx.inventoryLevel.fields.lowStockThreshold } } : {}),
          },
          include: {
            product: { select: { name: true, sku: true, isKey: true } },
            variant: { select: { name: true, sku: true } },
          },
          orderBy: { id: 'asc' },
          take: limit + 1,
          ...cursorArgs(cursor),
        });
        const page = pageOf(rows, limit);
        return {
          items: page.items.map((l) => ({
            productId: l.productId,
            productName: l.product.name,
            variantId: l.variantId,
            variantName: l.variant?.name ?? null,
            sku: l.variant?.sku ?? l.product.sku,
            isKey: l.product.isKey,
            stock: levelOf(l),
            updatedAt: l.updatedAt.toISOString(),
          })),
          nextCursor: page.nextCursor,
        };
      });
    },
  );

  /** Newest first. */
  r.get(
    '/:merchantId/inventory/movements',
    {
      schema: {
        tags,
        params,
        querystring: listStockMovementsQuerySchema,
        response: { 200: cursorPageSchema(stockMovementSchema) },
      },
      preHandler: requireMerchantPermission(),
    },
    async (req) => {
      const { merchantId } = req.params;
      const { cursor, limit, productId } = req.query;
      return withMerchantContext(app.db, merchantId, async (tx) => {
        const rows = await tx.inventoryMovement.findMany({
          where: { merchantId, ...(productId ? { productId } : {}) },
          orderBy: { id: 'desc' },
          take: limit + 1,
          ...cursorArgs(cursor),
        });
        const page = pageOf(rows, limit);
        return {
          items: page.items.map((m): StockMovement => ({
            id: m.id,
            productId: m.productId,
            variantId: m.variantId,
            delta: m.delta,
            reason: m.reason as StockMovement['reason'],
            orderId: m.orderId,
            actorUserId: m.actorUserId,
            note: m.note,
            createdAt: m.createdAt.toISOString(),
          })),
          nextCursor: page.nextCursor,
        };
      });
    },
  );
}
