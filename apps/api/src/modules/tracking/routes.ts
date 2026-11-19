import {
  isTerminalStatus,
  publicTrackingSchema,
  riderLocationBatchInputSchema,
  riderLocationResultSchema,
  trackingLinkSchema,
  trackTokenParamsSchema,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { authOf, requireAuth, requireRole } from '../../plugins/auth.js';
import { approvedRiderId, ingestRiderLocation, lastSeen } from './location.js';
import { signTrackingToken, TRACKING_GRACE_MS, verifyTrackingToken } from './token.js';

/** When the order stopped being live (tracking expires an hour later); null while live. */
function endedAt(o: {
  status: Parameters<typeof isTerminalStatus>[0];
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  updatedAt: Date;
}): Date | null {
  if (!isTerminalStatus(o.status)) return null;
  return o.deliveredAt ?? o.cancelledAt ?? o.updatedAt;
}

const trackPath = (token: string) => `/v1/track/${token}`;

/** /v1/rider/location: batched GPS upload (the socket `rider.location` is the live path). */
export async function riderLocationRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post(
    '/',
    {
      schema: {
        tags: ['rider-location'],
        body: riderLocationBatchInputSchema,
        response: { 200: riderLocationResultSchema },
      },
      preHandler: requireRole('rider'),
    },
    async (req) => {
      const riderId = await approvedRiderId(app.db, authOf(req).userId);
      return ingestRiderLocation(
        { db: app.db, redis: app.redis, io: app.realtime.io, log: req.log },
        riderId,
        req.body.pings,
      );
    },
  );
}

/** /v1/orders/:orderId/tracking-link: the customer's shareable link. */
export async function orderTrackingLinkRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/:orderId/tracking-link',
    {
      schema: {
        tags: ['orders'],
        params: z.object({ orderId: z.uuid() }),
        response: { 200: trackingLinkSchema },
      },
      preHandler: requireAuth,
    },
    async (req) => {
      const o = await app.db.order.findFirst({
        where: { id: req.params.orderId, customerId: authOf(req).userId },
        select: { id: true, status: true, deliveredAt: true, cancelledAt: true, updatedAt: true },
      });
      if (!o) throw new AppError('NOT_FOUND', 'Order not found');
      const ended = endedAt(o);
      const token = signTrackingToken(app.env.JWT_ACCESS_SECRET, o.id);
      return {
        token,
        path: trackPath(token),
        expiresAt: ended ? new Date(ended.getTime() + TRACKING_GRACE_MS).toISOString() : null,
      };
    },
  );
}

/** /v1/track/:token: public, unauthenticated live tracking. */
export async function publicTrackingRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/:token',
    {
      schema: {
        tags: ['tracking'],
        params: trackTokenParamsSchema,
        response: { 200: publicTrackingSchema },
      },
    },
    async (req, reply) => {
      void reply.header('cache-control', 'no-store');
      // Forged, unknown and expired tokens all look the same.
      const notFound = () => new AppError('NOT_FOUND', 'Tracking link not found or expired');
      const orderId = verifyTrackingToken(app.env.JWT_ACCESS_SECRET, req.params.token);
      if (!orderId) throw notFound();
      const o = await app.db.order.findUnique({
        where: { id: orderId },
        select: {
          code: true,
          status: true,
          version: true,
          etaAt: true,
          deliveredAt: true,
          cancelledAt: true,
          updatedAt: true,
          merchant: { select: { name: true, lat: true, lng: true } },
          rider: {
            select: {
              id: true,
              plateNumber: true,
              vehicleType: true,
              user: { select: { firstName: true } },
            },
          },
        },
      });
      if (!o) throw notFound();
      const ended = endedAt(o);
      if (ended && Date.now() > ended.getTime() + TRACKING_GRACE_MS) throw notFound();

      const seen = o.rider && !ended ? await lastSeen(app.redis, o.rider.id) : null;
      return {
        code: o.code,
        status: o.status,
        version: o.version,
        etaAt: o.etaAt?.toISOString() ?? null,
        storeName: o.merchant.name,
        storeLocation: { lat: o.merchant.lat, lng: o.merchant.lng },
        rider: o.rider
          ? {
              firstName: o.rider.user.firstName,
              plateNumber: o.rider.plateNumber,
              vehicleType: o.rider.vehicleType,
              location: seen
                ? {
                    lat: seen.lat,
                    lng: seen.lng,
                    heading: seen.heading,
                    updatedAt: seen.at.toISOString(),
                  }
                : null,
            }
          : null,
        updatedAt: o.updatedAt.toISOString(),
      };
    },
  );
}
