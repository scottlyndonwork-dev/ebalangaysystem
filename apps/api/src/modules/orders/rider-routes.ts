import { orderSchema, transitionOrderInputSchema } from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Tx } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { authOf, requireRole } from '../../plugins/auth.js';
import { loadOrder, toOrder } from './service.js';
import { transitionOrder } from './transitions.js';

const params = z.object({ orderId: z.uuid() });

/** The order, if it is assigned to the calling rider (404 otherwise). */
async function riderOrder(db: Db | Tx, userId: string, orderId: string) {
  const rider = await db.rider.findUnique({ where: { userId }, select: { id: true } });
  if (!rider) throw new AppError('NOT_FOUND', 'Order not found');
  return loadOrder(db, { id: orderId, riderId: rider.id });
}

/**
 * /v1/rider/orders — the assigned rider's status updates (arrived, picked up, on the way,
 * nearby, delivered, failed). Offers, dispatch and tracking come with the rider phase.
 */
export async function riderOrderRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['rider-orders'];
  const riderOnly = requireRole('rider');

  r.get(
    '/:orderId',
    { schema: { tags, params, response: { 200: orderSchema } }, preHandler: riderOnly },
    async (req) => toOrder(await riderOrder(app.db, authOf(req).userId, req.params.orderId)),
  );

  r.post(
    '/:orderId/transition',
    {
      schema: { tags, params, body: transitionOrderInputSchema, response: { 200: orderSchema } },
      preHandler: riderOnly,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const o = await app.db.$transaction(async (tx) => {
        await riderOrder(tx, userId, req.params.orderId);
        return transitionOrder(tx, {
          orderId: req.params.orderId,
          to: req.body.to,
          actor: 'rider',
          actorUserId: userId,
          expectedVersion: req.body.version,
          reason: req.body.reason,
        });
      });
      return toOrder(o);
    },
  );
}
