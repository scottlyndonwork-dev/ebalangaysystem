import type { Tx } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import type { OrderRow } from './service.js';
import { transitionOrder } from './transitions.js';

/**
 * Assign a rider (status -> rider_assigned). Called by dispatch (SYSTEM) or an admin; the
 * matching engine itself arrives in the rider phase.
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
  return transitionOrder(tx, {
    orderId: args.orderId,
    to: 'rider_assigned',
    actor: args.actor,
    actorUserId: args.actorUserId ?? null,
    expectedVersion: args.expectedVersion,
    data: { riderId: args.riderId },
  });
}
