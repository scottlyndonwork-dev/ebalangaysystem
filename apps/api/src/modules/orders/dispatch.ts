import type { Tx } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import { haversineM } from '../../lib/geo.js';
import type { OrderRow } from './service.js';
import { transitionOrder } from './transitions.js';

/**
 * Assign a rider (status -> rider_assigned) and open the rider job: one Delivery with a pickup
 * and a dropoff leg. Called by dispatch (SYSTEM) or an admin; the matching engine itself (offers,
 * batching several orders into one delivery) arrives in the rider phase.
 */
export async function assignRider(
  tx: Tx,
  args: {
    orderId: string;
    riderId: string;
    actor: 'system' | 'admin';
    actorUserId?: string | null;
    expectedVersion?: number;
  },
): Promise<OrderRow> {
  const rider = await tx.rider.findUnique({
    where: { id: args.riderId },
    select: { verificationStatus: true },
  });
  if (rider?.verificationStatus !== 'approved') {
    throw new AppError('VALIDATION_FAILED', 'Rider is not approved');
  }
  const order = await transitionOrder(tx, {
    orderId: args.orderId,
    to: 'rider_assigned',
    actor: args.actor,
    actorUserId: args.actorUserId ?? null,
    expectedVersion: args.expectedVersion,
    data: { riderId: args.riderId },
  });
  if (order.dropoffLat === null || order.dropoffLng === null) {
    throw new AppError('VALIDATION_FAILED', 'Order has no drop-off location');
  }
  const store = await tx.merchant.findUniqueOrThrow({
    where: { id: order.merchantId },
    select: { lat: true, lng: true, zoneId: true },
  });
  const dropoff = { lat: order.dropoffLat, lng: order.dropoffLng };
  await tx.delivery.create({
    data: {
      riderId: args.riderId,
      zoneId: store.zoneId,
      status: 'assigned',
      assignedAt: new Date(),
      distanceMeters: Math.round(haversineM(store, dropoff)),
      riderFeeCentavos: order.riderEarningCentavos,
      legs: {
        create: [
          { orderId: order.id, sequence: 1, kind: 'pickup', lat: store.lat, lng: store.lng },
          { orderId: order.id, sequence: 2, kind: 'dropoff', ...dropoff },
        ],
      },
    },
  });
  return order;
}
