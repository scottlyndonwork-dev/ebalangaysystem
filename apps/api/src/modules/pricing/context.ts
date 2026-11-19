/** DB loaders that feed the pure pricing/ETA functions. */
import type { Db, Tx } from '../../db.js';
import { deliveryFee, type ZoneFeeRules } from './engine.js';
import { estimateEta, type PrepSample } from './eta.js';
import { loadPricingSettings, type PricingSettings } from './settings.js';
import { resolveSurgeBps, type DemandSnapshot } from './surge.js';

const PREP_HISTORY_DAYS = 30;
/** Orders that still need a rider. */
const AWAITING_RIDER = ['confirmed', 'preparing', 'ready'] as const;

export interface ZonePricing {
  zoneId: string;
  fees: ZoneFeeRules;
  demand: DemandSnapshot;
  surgeBps: number;
}

export async function loadDemand(db: Db | Tx, zoneId: string): Promise<DemandSnapshot> {
  // Sequential: these may run inside an interactive transaction.
  const availableRiders = await db.rider.count({
    where: { status: 'online', verificationStatus: 'approved', zones: { some: { zoneId } } },
  });
  const pendingOrders = await db.order.count({
    where: { riderId: null, status: { in: [...AWAITING_RIDER] }, merchant: { zoneId } },
  });
  return { availableRiders, pendingOrders };
}

export async function loadZonePricing(
  db: Db | Tx,
  zoneId: string,
  now: Date,
  settings: PricingSettings,
): Promise<ZonePricing | null> {
  const zone = await db.zone.findFirst({
    where: { id: zoneId, isActive: true },
    include: {
      feeTiers: true,
      surgeRules: { where: { isActive: true } },
      surgeEvents: {
        where: { startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      },
    },
  });
  if (!zone) return null;
  const demand = await loadDemand(db, zoneId);
  return {
    zoneId,
    fees: {
      baseDeliveryFeeCentavos: Number(zone.baseDeliveryFeeCentavos),
      perKmFeeCentavos: Number(zone.perKmFeeCentavos),
      tiers: zone.feeTiers.map((t) => ({
        minDistanceM: t.minDistanceM,
        maxDistanceM: t.maxDistanceM,
        feeCentavos: Number(t.feeCentavos),
      })),
    },
    demand,
    surgeBps: resolveSurgeBps({
      now,
      events: zone.surgeEvents,
      rules: zone.surgeRules,
      demand,
      maxSurgeBps: settings.maxSurgeBps,
    }),
  };
}

/** Median confirmed -> ready minutes per merchant (last 30 days, >= 5 orders), for browse ETAs. */
export async function loadPrepMedians(
  db: Db | Tx,
  merchantIds: string[],
  now: Date,
): Promise<Map<string, number>> {
  if (!merchantIds.length) return new Map();
  const since = new Date(now.getTime() - PREP_HISTORY_DAYS * 86_400_000);
  const rows = await db.$queryRaw<{ merchant_id: string; minutes: number }[]>`
    SELECT merchant_id,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ready_at - confirmed_at) / 60)::float8 AS minutes
    FROM orders
    WHERE merchant_id = ANY(${merchantIds}::uuid[]) AND placed_at >= ${since}
      AND confirmed_at IS NOT NULL AND ready_at > confirmed_at
    GROUP BY merchant_id HAVING count(*) >= 5`;
  return new Map(rows.map((r) => [r.merchant_id, Math.round(r.minutes)]));
}

/** Recent prep samples for one merchant (input to suggestPrepMinutes). */
export async function loadPrepSamples(
  db: Db | Tx,
  merchantId: string,
  now: Date,
  limit = 200,
): Promise<PrepSample[]> {
  const since = new Date(now.getTime() - PREP_HISTORY_DAYS * 86_400_000);
  const rows = await db.$queryRaw<{ minutes: number; item_count: number }[]>`
    SELECT extract(epoch FROM o.ready_at - o.confirmed_at)::float8 / 60 AS minutes,
      (SELECT coalesce(sum(i.quantity), 0)::int FROM order_items i WHERE i.order_id = o.id) AS item_count
    FROM orders o
    WHERE o.merchant_id = ${merchantId}::uuid AND o.placed_at >= ${since}
      AND o.confirmed_at IS NOT NULL AND o.ready_at > o.confirmed_at
    ORDER BY o.placed_at DESC LIMIT ${limit}::int`;
  return rows.map((r) => ({ minutes: r.minutes, itemCount: r.item_count }));
}

export interface StoreDeliveryEstimate {
  /** What the customer pays for delivery (0 when the merchant offers free delivery). */
  deliveryFeeCentavos: number;
  etaMinutes: number;
}

export function estimateStoreDelivery(
  zone: ZonePricing,
  store: { freeDelivery: boolean; prepTimeMinutes: number },
  distanceM: number,
  prepMedianMinutes?: number,
): StoreDeliveryEstimate {
  return {
    deliveryFeeCentavos: store.freeDelivery ? 0 : deliveryFee(distanceM, zone.fees, zone.surgeBps),
    etaMinutes: estimateEta({
      prepMinutes: prepMedianMinutes ?? store.prepTimeMinutes,
      distanceM,
      demand: zone.demand,
    }).minutes,
  };
}

/** One-call helper for routes: settings + zone context + prep medians. */
export async function loadBrowsePricing(
  db: Db | Tx,
  zoneId: string,
  merchantIds: string[],
  now: Date,
) {
  const settings = await loadPricingSettings(db);
  const zone = await loadZonePricing(db, zoneId, now, settings);
  const prep = await loadPrepMedians(db, merchantIds, now);
  return { zone, prep };
}
