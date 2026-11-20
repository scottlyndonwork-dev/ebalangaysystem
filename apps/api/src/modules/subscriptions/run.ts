import {
  cartItemSelectionSchema,
  formatManilaShort,
  Rooms,
  SocketEvent,
  toManilaParts,
} from '@ebalangay/shared';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db, Tx } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import { writeEvent } from '../../lib/outbox.js';
import { loadAddress, loadMerchantForCart, quoteCart } from '../carts/quote.js';
import { loadOrderOpsSettings } from '../orders/ops-settings.js';
import { MIN_SCHEDULE_LEAD_MINUTES, placeFromLines } from '../orders/place.js';

export const SUBSCRIPTION_BATCH_SIZE = 50;
const DAY_MS = 86_400_000;
const itemsSchema = z.array(cartItemSelectionSchema).min(1).max(100);

export const Cadence = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  BIWEEKLY: 'biweekly',
  MONTHLY: 'monthly',
};

/**
 * Next run after `at`. Monthly keeps the Manila wall-clock day and time, clamped to the month's
 * last day (Jan 31 -> Feb 28). PH has no DST, so day cadences are fixed offsets.
 */
export function nextRunAfter(at: Date, cadence: string): Date {
  switch (cadence) {
    case Cadence.DAILY:
      return new Date(at.getTime() + DAY_MS);
    case Cadence.WEEKLY:
      return new Date(at.getTime() + 7 * DAY_MS);
    case Cadence.BIWEEKLY:
      return new Date(at.getTime() + 14 * DAY_MS);
    case Cadence.MONTHLY: {
      const p = toManilaParts(at);
      const y = p.month === 12 ? p.year + 1 : p.year;
      const m = p.month === 12 ? 1 : p.month + 1;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const day = Math.min(p.day, lastDay);
      // Same Manila time of day: shift the UTC instant by whole Manila days.
      const fromDay = Date.UTC(p.year, p.month - 1, p.day);
      const toDay = Date.UTC(y, m - 1, day);
      return new Date(at.getTime() + (toDay - fromDay));
    }
    default:
      throw new Error(`unknown cadence ${cadence}`);
  }
}

/** First run strictly after `now` (catches up after downtime without placing missed runs). */
function advance(from: Date, cadence: string, now: Date): Date {
  let next = nextRunAfter(from, cadence);
  while (next <= now) next = nextRunAfter(next, cadence);
  return next;
}

export const SkipReason = {
  MISSED: 'missed',
  STORE_UNAVAILABLE: 'store_unavailable',
  ADDRESS_MISSING: 'address_missing',
  PAYMENT_METHOD_UNAVAILABLE: 'payment_method_unavailable',
  BLOCKED: 'blocked',
  INVALID_ITEMS: 'invalid_items',
} as const;

export interface SubscriptionRunResult {
  placed: number;
  skipped: number;
}

type SubRow = {
  id: string;
  userId: string;
  merchantId: string;
  addressId: string;
  items: unknown;
  paymentMethod: string;
  cadence: string;
  nextRunAt: Date;
};

class Skip extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Places the scheduled order for each active recurring order whose run is within the lead time
 * (or the store's advance-notice rule, if longer). A run that can't be placed is skipped, the
 * customer is told, and the subscription moves on to its next run either way.
 */
export async function runSubscriptions(
  deps: { db: Db; log?: Logger },
  now = new Date(),
): Promise<SubscriptionRunResult> {
  const { db } = deps;
  const s = await loadOrderOpsSettings(db);
  const due = await db.$queryRaw<{ id: string }[]>`
    SELECT so.id FROM subscription_orders so JOIN merchants m ON m.id = so.merchant_id
    WHERE so.status = 'active'
      AND so.next_run_at <= ${now}::timestamptz + make_interval(
            mins => GREATEST(${s.subscriptionLeadMinutes}::int, m.advance_order_hours * 60))
    ORDER BY so.next_run_at, so.id
    LIMIT ${SUBSCRIPTION_BATCH_SIZE}`;

  const result: SubscriptionRunResult = { placed: 0, skipped: 0 };
  for (const { id } of due) {
    let outcome: 'placed' | 'skipped' | null;
    try {
      outcome = await db.$transaction((tx) => runOne(tx, id, now, null));
    } catch (err) {
      // Pricing/stock problems roll the placement back; record the skip in a fresh transaction.
      const reason =
        err instanceof Skip ? err.reason : err instanceof AppError ? err.code.toLowerCase() : null;
      if (!reason) throw err;
      outcome = await db.$transaction((tx) => runOne(tx, id, now, reason));
    }
    if (outcome === 'placed') result.placed++;
    else if (outcome === 'skipped') result.skipped++;
  }
  if (result.placed || result.skipped) deps.log?.info(result, 'subscription orders run');
  return result;
}

async function runOne(
  tx: Tx,
  id: string,
  now: Date,
  skipReason: string | null,
): Promise<'placed' | 'skipped' | null> {
  const [sub] = await tx.$queryRaw<SubRow[]>`
    SELECT id, user_id AS "userId", merchant_id AS "merchantId", address_id AS "addressId",
           items, payment_method::text AS "paymentMethod", cadence, next_run_at AS "nextRunAt"
    FROM subscription_orders WHERE id = ${id}::uuid AND status = 'active'
    FOR UPDATE SKIP LOCKED`;
  // Paused/cancelled meanwhile, or another worker holds it.
  if (!sub) return null;

  const runAt = sub.nextRunAt;
  const next = advance(runAt, sub.cadence, now);
  let orderId: string | null = null;
  let reason = skipReason;
  if (!reason) {
    try {
      orderId = await placeRun(tx, sub, runAt, now);
    } catch (err) {
      if (err instanceof Skip) reason = err.reason;
      else throw err;
    }
  }

  await tx.subscriptionOrder.update({ where: { id }, data: { nextRunAt: next } });
  const merchant = await tx.merchant.findUnique({
    where: { id: sub.merchantId },
    select: { name: true },
  });
  const key = orderId ? 'subscriptionPlaced' : 'subscriptionSkipped';
  await writeEvent(tx, {
    event: SocketEvent.SUBSCRIPTION_RUN,
    aggregateType: 'subscription_order',
    aggregateId: id,
    // nextRunAt only moves forward, so its epoch-minute orders the events.
    version: Math.floor(next.getTime() / 60_000),
    data: {
      subscriptionOrderId: id,
      orderId,
      skippedReason: orderId ? null : reason,
      nextRunAt: next.toISOString(),
    },
    rooms: [Rooms.user(sub.userId)],
    push: {
      userIds: [sub.userId],
      titleKey: `notifications:${key}.title`,
      bodyKey: `notifications:${key}.body`,
      params: {
        store: merchant?.name ?? '',
        time: formatManilaShort(orderId ? runAt : next),
      },
      category: 'order',
      app: 'customer',
      dedupeKey: `subscription:${id}:${runAt.toISOString()}`,
    },
    occurredAt: now,
  });
  return orderId ? 'placed' : 'skipped';
}

/** Throws Skip for expected problems; AppErrors from placement mean a rollback + skip. */
async function placeRun(tx: Tx, sub: SubRow, runAt: Date, now: Date): Promise<string> {
  if (runAt.getTime() - now.getTime() < MIN_SCHEDULE_LEAD_MINUTES * 60_000) {
    throw new Skip(SkipReason.MISSED);
  }
  // Online payments arrive with the payments phase; until then recurring orders are COD.
  if (sub.paymentMethod !== 'cod') throw new Skip(SkipReason.PAYMENT_METHOD_UNAVAILABLE);
  const items = itemsSchema.safeParse(sub.items);
  if (!items.success) throw new Skip(SkipReason.INVALID_ITEMS);

  const merchant = await loadMerchantForCart(tx, sub.merchantId, now).catch(() => {
    throw new Skip(SkipReason.STORE_UNAVAILABLE);
  });
  const blocked = await tx.merchantCustomerBlock.findUnique({
    where: { merchantId_userId: { merchantId: merchant.id, userId: sub.userId } },
    select: { userId: true },
  });
  if (blocked) throw new Skip(SkipReason.BLOCKED);
  const address = await loadAddress(tx, sub.userId, sub.addressId);
  if (!address) throw new Skip(SkipReason.ADDRESS_MISSING);

  const q = await quoteCart(tx, {
    userId: sub.userId,
    merchant,
    selections: items.data.map((sel, n) => ({ key: String(n), ...sel })),
    address,
    requireAddress: true,
    voucherCode: null,
    now,
    at: runAt,
  });
  if (!q.canCheckout) {
    const blocking = q.issues.find((i) => i.blocking);
    throw new Skip((blocking?.code ?? 'not_orderable').toLowerCase());
  }

  const order = await placeFromLines(tx, {
    userId: sub.userId,
    merchant,
    quote: q,
    addressId: sub.addressId,
    type: 'subscription',
    paymentMethod: 'cod',
    scheduledFor: runAt,
    subscriptionOrderId: sub.id,
    // Unique per customer: a run can never place two orders.
    idempotencyKey: `subscription:${sub.id}:${runAt.toISOString()}`,
    actor: 'system',
    now,
  });
  return order.id;
}
