import { formatManilaShort, Rooms, SocketEvent } from '@ebalangay/shared';
import type { Db } from '../../db.js';
import { writeEvent } from '../../lib/outbox.js';
import { loadOrderOpsSettings } from './ops-settings.js';
import { merchantStaffUserIds } from './transitions.js';

export const RELEASE_BATCH_SIZE = 100;

export interface ReleaseResult {
  released: number;
  /** Of those, still waiting for the merchant to accept (reminder sent). */
  unconfirmed: number;
}

/**
 * Scheduled orders become due at scheduledFor − prep time − dispatch buffer: stamp released_at
 * once and tell the merchant to start preparing (or, if not yet accepted, to accept now; the
 * sweeper cancels it after the grace period).
 */
export async function releaseScheduledOrders(db: Db, now = new Date()): Promise<ReleaseResult> {
  const s = await loadOrderOpsSettings(db);
  const due = await db.$queryRaw<{ id: string }[]>`
    SELECT o.id FROM orders o JOIN merchants m ON m.id = o.merchant_id
    WHERE o.released_at IS NULL
      AND o.scheduled_for IS NOT NULL
      AND o.scheduled_for <= ${now}::timestamptz + interval '1 day'
      AND o.status::text NOT IN ('pending_payment', 'delivered', 'cancelled', 'failed')
      AND o.scheduled_for - make_interval(
            mins => COALESCE(o.prep_time_minutes, m.prep_time_minutes)
                    + ${s.scheduledDispatchBufferMinutes}::int
          ) <= ${now}::timestamptz
    ORDER BY o.scheduled_for, o.id
    LIMIT ${RELEASE_BATCH_SIZE}`;

  const result: ReleaseResult = { released: 0, unconfirmed: 0 };
  for (const { id } of due) {
    await db.$transaction(async (tx) => {
      // Guarded write: a concurrent run (or replica) that got here first wins.
      const { count } = await tx.order.updateMany({
        where: { id, releasedAt: null },
        data: { releasedAt: now },
      });
      if (count === 0) return;
      result.released++;
      const o = await tx.order.findUniqueOrThrow({
        where: { id },
        select: { code: true, version: true, status: true, merchantId: true, scheduledFor: true },
      });
      // Already further along (merchant started early): nothing to tell.
      if (o.status !== 'placed' && o.status !== 'confirmed') return;
      const unconfirmed = o.status === 'placed';
      if (unconfirmed) result.unconfirmed++;
      const key = unconfirmed ? 'scheduledUnconfirmed' : 'scheduledRelease';
      const scheduledFor = o.scheduledFor ?? now;
      await writeEvent(tx, {
        event: SocketEvent.MERCHANT_ORDER_RELEASED,
        aggregateType: 'order',
        aggregateId: id,
        version: o.version,
        data: { orderId: id, code: o.code, scheduledFor: scheduledFor.toISOString() },
        rooms: [Rooms.merchant(o.merchantId)],
        push: {
          userIds: await merchantStaffUserIds(tx, o.merchantId),
          titleKey: `notifications:${key}.title`,
          bodyKey: `notifications:${key}.body`,
          params: { code: o.code, time: formatManilaShort(scheduledFor) },
          category: 'order',
          app: 'merchant',
          dedupeKey: `order:${id}:released`,
        },
        occurredAt: now,
      });
    });
  }
  return result;
}
