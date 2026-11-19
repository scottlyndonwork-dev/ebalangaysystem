import {
  cancelOrderInputSchema,
  createOrderInputSchema,
  cursorPageSchema,
  Headers,
  listOrdersQuerySchema,
  orderSchema,
  respondReplacementInputSchema,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { authOf, requireAuth } from '../../plugins/auth.js';
import { cursorArgs, pageOf } from '../catalog/service.js';
import { placeOrder } from './place.js';
import { respondReplacement } from './replacements.js';
import { loadOrder, orderInclude, toOrder } from './service.js';
import { transitionOrder } from './transitions.js';

const orderParams = z.object({ orderId: z.uuid() });
// Loose: validated headers replace req.headers, so unknown ones (authorization) must survive.
const idempotencyHeaders = z.looseObject({
  [Headers.IDEMPOTENCY_KEY]: z.string().trim().min(8).max(100),
});

export function listWhere(q: z.output<typeof listOrdersQuerySchema>): Prisma.OrderWhereInput {
  return {
    ...(q.status ? { status: { in: q.status } } : {}),
    ...(q.from || q.to
      ? {
          createdAt: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to ? { lt: new Date(q.to) } : {}),
          },
        }
      : {}),
  };
}

/** /v1/orders — the customer's own orders. */
export async function orderRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['orders'];

  r.post(
    '/',
    {
      schema: {
        tags,
        headers: idempotencyHeaders,
        body: createOrderInputSchema,
        response: { 200: orderSchema, 201: orderSchema },
      },
      preHandler: requireAuth,
    },
    async (req, reply) => {
      const { order, created } = await placeOrder(
        app.db,
        authOf(req).userId,
        req.body,
        req.headers[Headers.IDEMPOTENCY_KEY],
      );
      return reply.status(created ? 201 : 200).send(toOrder(order));
    },
  );

  r.get(
    '/',
    {
      schema: {
        tags,
        querystring: listOrdersQuerySchema,
        response: { 200: cursorPageSchema(orderSchema) },
      },
      preHandler: requireAuth,
    },
    async (req) => {
      const q = req.query;
      const rows = await app.db.order.findMany({
        where: {
          customerId: authOf(req).userId,
          ...(q.merchantId ? { merchantId: q.merchantId } : {}),
          ...listWhere(q),
        },
        include: orderInclude,
        orderBy: { id: 'desc' },
        take: q.limit + 1,
        ...cursorArgs(q.cursor),
      });
      const page = pageOf(rows, q.limit);
      return { items: page.items.map(toOrder), nextCursor: page.nextCursor };
    },
  );

  r.get(
    '/:orderId',
    {
      schema: { tags, params: orderParams, response: { 200: orderSchema } },
      preHandler: requireAuth,
    },
    async (req) =>
      toOrder(await loadOrder(app.db, { id: req.params.orderId, customerId: authOf(req).userId })),
  );

  r.post(
    '/:orderId/cancel',
    {
      schema: {
        tags,
        params: orderParams,
        body: cancelOrderInputSchema,
        response: { 200: orderSchema },
      },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const order = await app.db.$transaction(async (tx) => {
        await loadOrder(tx, { id: req.params.orderId, customerId: userId });
        return transitionOrder(tx, {
          orderId: req.params.orderId,
          to: 'cancelled',
          actor: 'customer',
          actorUserId: userId,
          expectedVersion: req.body.version,
          reason: req.body.reason,
        });
      });
      return toOrder(order);
    },
  );

  r.post(
    '/:orderId/replacements/:replacementId/respond',
    {
      schema: {
        tags,
        params: orderParams.extend({ replacementId: z.uuid() }),
        body: respondReplacementInputSchema,
        response: { 200: orderSchema },
      },
      preHandler: requireAuth,
    },
    async (req) => {
      const order = await app.db.$transaction((tx) =>
        respondReplacement(tx, {
          customerId: authOf(req).userId,
          orderId: req.params.orderId,
          replacementId: req.params.replacementId,
          accept: req.body.accept,
        }),
      );
      return toOrder(order);
    },
  );
}
