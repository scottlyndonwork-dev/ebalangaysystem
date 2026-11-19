import {
  acceptOrderInputSchema,
  blockCustomerInputSchema,
  customerBlockSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  listOrdersQuerySchema,
  MerchantPermission,
  merchantOrderSchema,
  type OrderStatus,
  prepSuggestionSchema,
  prepUpdateInputSchema,
  proposeReplacementInputSchema,
  rejectOrderInputSchema,
  SocketEvent,
  transitionOrderInputSchema,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Tx } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { authOf, requireMerchantPermission } from '../../plugins/auth.js';
import { cursorArgs, pageOf } from '../catalog/service.js';
import { prepSuggestion } from './place.js';
import { proposeReplacement } from './replacements.js';
import { listWhere } from './routes.js';
import {
  activeItems,
  loadOrder,
  orderInclude,
  type OrderRow,
  orderRooms,
  toMerchantOrder,
  writeOutbox,
} from './service.js';
import { transitionOrder } from './transitions.js';

const merchantParams = z.object({ merchantId: z.uuid() });
const orderParams = merchantParams.extend({ orderId: z.uuid() });
const blockParams = merchantParams.extend({ userId: z.uuid() });

const PREP_UPDATE_STATUSES: readonly OrderStatus[] = ['confirmed', 'preparing', 'ready'];

async function render(db: Db | Tx, o: OrderRow) {
  const c = o.customerId
    ? await db.user.findUnique({
        where: { id: o.customerId },
        select: { firstName: true, lastName: true },
      })
    : null;
  const name = c ? `${c.firstName} ${c.lastName}`.trim() : '';
  return toMerchantOrder(o, name || null);
}

const itemCountOf = (o: OrderRow) => activeItems(o).reduce((n, i) => n + i.quantity, 0);

/** /v1/merchants/:merchantId/orders and customer blocks. Staff need orders.manage. */
export async function merchantOrderRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['merchant-orders'];
  const canManage = requireMerchantPermission(MerchantPermission.ORDERS_MANAGE);
  const own = (merchantId: string, orderId: string, db: Db | Tx = app.db) =>
    loadOrder(db, { id: orderId, merchantId });

  r.get(
    '/:merchantId/orders',
    {
      schema: {
        tags,
        params: merchantParams,
        querystring: listOrdersQuerySchema,
        response: { 200: cursorPageSchema(merchantOrderSchema) },
      },
      preHandler: canManage,
    },
    async (req) => {
      const q = req.query;
      const rows = await app.db.order.findMany({
        where: { merchantId: req.params.merchantId, ...listWhere(q) },
        include: orderInclude,
        orderBy: { id: 'desc' },
        take: q.limit + 1,
        ...cursorArgs(q.cursor),
      });
      const page = pageOf(rows, q.limit);
      const items = [];
      for (const o of page.items) items.push(await render(app.db, o));
      return { items, nextCursor: page.nextCursor };
    },
  );

  r.get(
    '/:merchantId/orders/:orderId',
    {
      schema: { tags, params: orderParams, response: { 200: merchantOrderSchema } },
      preHandler: canManage,
    },
    async (req) => render(app.db, await own(req.params.merchantId, req.params.orderId)),
  );

  r.get(
    '/:merchantId/orders/:orderId/prep-suggestion',
    {
      schema: { tags, params: orderParams, response: { 200: prepSuggestionSchema } },
      preHandler: canManage,
    },
    async (req) => {
      const o = await own(req.params.merchantId, req.params.orderId);
      const m = await app.db.merchant.findUniqueOrThrow({
        where: { id: o.merchantId },
        select: { id: true, prepTimeMinutes: true },
      });
      return prepSuggestion(app.db, m, itemCountOf(o));
    },
  );

  r.post(
    '/:merchantId/orders/:orderId/accept',
    {
      schema: {
        tags,
        params: orderParams,
        body: acceptOrderInputSchema,
        response: { 200: merchantOrderSchema },
      },
      preHandler: canManage,
    },
    async (req) => {
      const { merchantId, orderId } = req.params;
      const now = new Date();
      const o = await app.db.$transaction(async (tx) => {
        const current = await own(merchantId, orderId, tx);
        let prep = req.body.prepTimeMinutes;
        if (prep === undefined) {
          const m = await tx.merchant.findUniqueOrThrow({
            where: { id: merchantId },
            select: { id: true, prepTimeMinutes: true },
          });
          prep = (await prepSuggestion(tx, m, itemCountOf(current), now)).minutes;
        }
        // A promise later than the checkout ETA pushes the ETA out; never pull it in.
        const ready = new Date(now.getTime() + prep * 60_000);
        const etaAt =
          !current.scheduledFor && current.etaAt && ready > current.etaAt ? ready : undefined;
        return transitionOrder(tx, {
          orderId,
          to: 'confirmed',
          actor: 'merchant',
          actorUserId: authOf(req).userId,
          expectedVersion: req.body.version,
          data: { prepTimeMinutes: prep, ...(etaAt ? { etaAt } : {}) },
          now,
        });
      });
      return render(app.db, o);
    },
  );

  r.post(
    '/:merchantId/orders/:orderId/reject',
    {
      schema: {
        tags,
        params: orderParams,
        body: rejectOrderInputSchema,
        response: { 200: merchantOrderSchema },
      },
      preHandler: canManage,
    },
    async (req) => {
      const { merchantId, orderId } = req.params;
      const o = await app.db.$transaction(async (tx) => {
        const current = await own(merchantId, orderId, tx);
        if (current.status !== 'placed') {
          throw new AppError(
            'INVALID_TRANSITION',
            'Only new orders can be rejected; cancel instead',
            {
              from: current.status,
              to: 'cancelled',
            },
          );
        }
        return transitionOrder(tx, {
          orderId,
          to: 'cancelled',
          actor: 'merchant',
          actorUserId: authOf(req).userId,
          expectedVersion: req.body.version,
          reason: req.body.reason,
        });
      });
      return render(app.db, o);
    },
  );

  r.post(
    '/:merchantId/orders/:orderId/transition',
    {
      schema: {
        tags,
        params: orderParams,
        body: transitionOrderInputSchema,
        response: { 200: merchantOrderSchema },
      },
      preHandler: canManage,
    },
    async (req) => {
      const { merchantId, orderId } = req.params;
      if (req.body.to === 'confirmed') {
        throw new AppError('VALIDATION_FAILED', 'Use the accept endpoint');
      }
      const o = await app.db.$transaction(async (tx) => {
        await own(merchantId, orderId, tx);
        return transitionOrder(tx, {
          orderId,
          to: req.body.to,
          actor: 'merchant',
          actorUserId: authOf(req).userId,
          expectedVersion: req.body.version,
          reason: req.body.reason,
        });
      });
      return render(app.db, o);
    },
  );

  r.post(
    '/:merchantId/orders/:orderId/prep',
    {
      schema: {
        tags,
        params: orderParams,
        body: prepUpdateInputSchema,
        response: { 200: merchantOrderSchema },
      },
      preHandler: canManage,
    },
    async (req) => {
      const { merchantId, orderId } = req.params;
      const { prepUpdate, etaMinutes } = req.body;
      const now = new Date();
      const o = await app.db.$transaction(async (tx) => {
        const current = await own(merchantId, orderId, tx);
        if (!PREP_UPDATE_STATUSES.includes(current.status)) {
          throw new AppError('CONFLICT', 'Prep updates are for accepted orders', {
            status: current.status,
          });
        }
        const etaAt =
          etaMinutes === undefined ? undefined : new Date(now.getTime() + etaMinutes * 60_000);
        const { count } = await tx.order.updateMany({
          where: { id: orderId, version: current.version },
          data: { prepUpdate, ...(etaAt ? { etaAt } : {}), version: { increment: 1 } },
        });
        if (count === 0) throw new AppError('CONFLICT', 'The order changed; refresh and try again');
        await tx.orderPrepUpdate.create({
          data: {
            orderId,
            prepUpdate,
            etaMinutes: etaMinutes ?? null,
            actorUserId: authOf(req).userId,
          },
        });
        const updated = await own(merchantId, orderId, tx);
        await writeOutbox(tx, {
          event: SocketEvent.ORDER_PREP_UPDATED,
          orderId,
          version: updated.version,
          data: { prepUpdate, etaAt: updated.etaAt?.toISOString() ?? null },
          rooms: orderRooms(updated),
        });
        return updated;
      });
      return render(app.db, o);
    },
  );

  r.post(
    '/:merchantId/orders/:orderId/replacements',
    {
      schema: {
        tags,
        params: orderParams,
        body: proposeReplacementInputSchema,
        response: { 201: merchantOrderSchema },
      },
      preHandler: canManage,
    },
    async (req, reply) => {
      const { merchantId, orderId } = req.params;
      const o = await app.db.$transaction((tx) =>
        proposeReplacement(tx, {
          merchantId,
          orderId,
          orderItemId: req.body.orderItemId,
          productId: req.body.productId,
          variantId: req.body.variantId,
          quantity: req.body.quantity,
          actorUserId: authOf(req).userId,
        }),
      );
      return reply.status(201).send(await render(app.db, o));
    },
  );

  // ---------------------------------------------------------------- customer blocks

  r.get(
    '/:merchantId/customer-blocks',
    {
      schema: {
        tags,
        params: merchantParams,
        querystring: cursorPageQuerySchema,
        response: { 200: cursorPageSchema(customerBlockSchema) },
      },
      preHandler: canManage,
    },
    async (req) => {
      const { limit, cursor } = req.query;
      const rows = await app.db.merchantCustomerBlock.findMany({
        where: { merchantId: req.params.merchantId },
        orderBy: { userId: 'asc' },
        take: limit + 1,
        ...(cursor
          ? {
              cursor: { merchantId_userId: { merchantId: req.params.merchantId, userId: cursor } },
              skip: 1,
            }
          : {}),
      });
      const page = pageOf(
        rows.map((b) => ({ ...b, id: b.userId })),
        limit,
      );
      return {
        items: page.items.map((b) => ({
          userId: b.userId,
          reason: b.reason,
          createdAt: b.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  r.put(
    '/:merchantId/customer-blocks',
    {
      schema: {
        tags,
        params: merchantParams,
        body: blockCustomerInputSchema,
        response: { 200: customerBlockSchema },
      },
      preHandler: canManage,
    },
    async (req) => {
      const { merchantId } = req.params;
      const { userId, reason } = req.body;
      // Only customers who ordered here can be blocked, so ids can't be probed.
      const ordered = await app.db.order.count({ where: { merchantId, customerId: userId } });
      if (!ordered) throw new AppError('NOT_FOUND', 'Customer not found');
      const b = await app.db.merchantCustomerBlock.upsert({
        where: { merchantId_userId: { merchantId, userId } },
        create: { merchantId, userId, reason, createdById: authOf(req).userId },
        update: { reason },
      });
      return { userId: b.userId, reason: b.reason, createdAt: b.createdAt.toISOString() };
    },
  );

  r.delete(
    '/:merchantId/customer-blocks/:userId',
    { schema: { tags, params: blockParams }, preHandler: canManage },
    async (req, reply) => {
      await app.db.merchantCustomerBlock.deleteMany({
        where: { merchantId: req.params.merchantId, userId: req.params.userId },
      });
      return reply.status(204).send();
    },
  );
}
