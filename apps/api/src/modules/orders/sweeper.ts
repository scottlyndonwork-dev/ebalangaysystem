import { Rooms, SocketEvent } from '@ebalangay/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { writeEvent } from '../../lib/outbox.js';
import type { RedisClient } from '../../redis.js';
import { loadOrderOpsSettings } from './ops-settings.js';
import { transitionOrder } from './transitions.js';

export const SWEEP_BATCH_SIZE = 100;
export const CancelReason = {
  PAYMENT_TIMEOUT: 'payment_timeout',
  MERCHANT_TIMEOUT: 'merchant_timeout',
} as const;
const ALERT_TTL_S = 24 * 3600;
export const noRiderAlertKey = (orderId: string) => `ops:alert:no_rider:${orderId}`;

export interface SweepResult {
  paymentTimeouts: number;
  merchantTimeouts: number;
  noRiderAlerts: number;
}

const ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);

/**
 * Cancels orders nobody acted on in time (unpaid, unaccepted) and flags accepted orders still
 * without a rider to the admin room. Every status change goes through the state machine as
 * SYSTEM, so stock, points and vouchers are released as for any cancellation.
 */
export async function sweepStaleOrders(
  deps: { db: Db; redis: RedisClient; log?: Logger },
  now = new Date(),
): Promise<SweepResult> {
  const { db } = deps;
  const s = await loadOrderOpsSettings(db);
  const pick = (where: Prisma.OrderWhereInput) =>
    db.order.findMany({
      where,
      select: { id: true, version: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SWEEP_BATCH_SIZE,
    });

  const unpaid = await pick({
    status: 'pending_payment',
    createdAt: { lt: ago(now, s.paymentTimeoutMinutes) },
  });
  const unaccepted = await pick({
    status: 'placed',
    OR: [
      { scheduledFor: null, placedAt: { lt: ago(now, s.merchantAcceptTimeoutMinutes) } },
      { releasedAt: { lt: ago(now, s.scheduledAcceptGraceMinutes) } },
    ],
  });

  const cancel = async (o: { id: string; version: number }, reason: string) => {
    try {
      await db.$transaction((tx) =>
        transitionOrder(tx, {
          orderId: o.id,
          to: 'cancelled',
          actor: 'system',
          actorUserId: null,
          expectedVersion: o.version,
          reason,
          now,
        }),
      );
      return 1;
    } catch (err) {
      // Someone acted on it meanwhile (paid, accepted, cancelled): leave it.
      if (err instanceof AppError && (err.code === 'CONFLICT' || err.code === 'INVALID_TRANSITION'))
        return 0;
      throw err;
    }
  };

  const result: SweepResult = { paymentTimeouts: 0, merchantTimeouts: 0, noRiderAlerts: 0 };
  for (const o of unpaid) result.paymentTimeouts += await cancel(o, CancelReason.PAYMENT_TIMEOUT);
  for (const o of unaccepted)
    result.merchantTimeouts += await cancel(o, CancelReason.MERCHANT_TIMEOUT);

  const cutoff = ago(now, s.noRiderAlertMinutes);
  const stuck = await db.order.findMany({
    where: {
      status: { in: ['confirmed', 'preparing', 'ready'] },
      riderId: null,
      type: { not: 'pos' },
      OR: [{ scheduledFor: null, confirmedAt: { lt: cutoff } }, { releasedAt: { lt: cutoff } }],
    },
    select: {
      id: true,
      code: true,
      version: true,
      status: true,
      confirmedAt: true,
      releasedAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: SWEEP_BATCH_SIZE,
  });
  for (const o of stuck) {
    // Once per order per day; the marker is dropped again if the write fails.
    const key = noRiderAlertKey(o.id);
    const fresh = await deps.redis.set(key, '1', 'EX', ALERT_TTL_S, 'NX');
    if (fresh !== 'OK') continue;
    const since = o.releasedAt ?? o.confirmedAt ?? now;
    try {
      await db.$transaction((tx) =>
        writeEvent(tx, {
          event: SocketEvent.ADMIN_ORDER_ALERT,
          aggregateType: 'order',
          aggregateId: o.id,
          version: o.version,
          data: {
            orderId: o.id,
            code: o.code,
            status: o.status,
            kind: 'no_rider',
            minutes: Math.floor((now.getTime() - since.getTime()) / 60_000),
          },
          rooms: [Rooms.admin()],
          occurredAt: now,
        }),
      );
      result.noRiderAlerts++;
    } catch (err) {
      await deps.redis.del(key);
      throw err;
    }
  }
  if (result.noRiderAlerts) deps.log?.warn({ count: result.noRiderAlerts }, 'orders without rider');
  return result;
}
