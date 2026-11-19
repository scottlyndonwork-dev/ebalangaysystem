/** Pure ETA + prep-time estimates. All durations in whole minutes. */
import { demandRatio, type DemandSnapshot } from './surge.js';

export const ETA = {
  /** Straight-line distance x this ~= road distance in Butuan's grid. */
  roadFactor: 1.3,
  /** Average motorcycle speed in city traffic. */
  speedKmh: 20,
  /** Time for an assigned rider to reach the store. */
  riderToStoreMinutes: 6,
  /** Base wait to find a rider; grows with demand per rider. */
  dispatchBaseMinutes: 2,
  dispatchPerExtraRatioMinutes: 5,
  /** Wait assumed when no rider is online in the zone. */
  noRiderMinutes: 20,
  dispatchMaxMinutes: 25,
  /** Parking, hand-off, finding the door. */
  handoffMinutes: 3,
  minPrepSamples: 5,
  prepPerExtraItemMinutes: 1,
  prepMinMinutes: 5,
  prepMaxMinutes: 120,
} as const;

export function travelMinutes(distanceM: number): number {
  const km = (Math.max(0, distanceM) * ETA.roadFactor) / 1000;
  return Math.ceil((km / ETA.speedKmh) * 60);
}

/** Expected wait until a rider is assigned, from rider supply vs open demand in the zone. */
export function dispatchMinutes(demand: DemandSnapshot): number {
  if (demand.availableRiders <= 0) return ETA.noRiderMinutes;
  const ratio = demandRatio({ ...demand, pendingOrders: demand.pendingOrders + 1 });
  const extra = Math.ceil(Math.max(0, ratio - 1) * ETA.dispatchPerExtraRatioMinutes);
  return Math.min(ETA.dispatchMaxMinutes, ETA.dispatchBaseMinutes + extra);
}

export interface EtaEstimate {
  minutes: number;
  /** Range shown to customers, e.g. "25-35 min". */
  minMinutes: number;
  maxMinutes: number;
}

/**
 * Rider dispatch + ride to the store run in parallel with prep; whichever is longer gates
 * pickup, then the delivery ride and hand-off.
 */
export function estimateEta(input: {
  prepMinutes: number;
  distanceM: number;
  demand: DemandSnapshot;
}): EtaEstimate {
  const toPickup = Math.max(
    Math.max(0, Math.round(input.prepMinutes)),
    dispatchMinutes(input.demand) + ETA.riderToStoreMinutes,
  );
  const minutes = toPickup + travelMinutes(input.distanceM) + ETA.handoffMinutes;
  return {
    minutes,
    minMinutes: Math.max(1, Math.floor(minutes * 0.85)),
    maxMinutes: Math.ceil(minutes * 1.2),
  };
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const hi = s[mid] ?? 0;
  return s.length % 2 ? hi : ((s[mid - 1] ?? 0) + hi) / 2;
}

export interface PrepSample {
  /** confirmed -> ready, minutes. */
  minutes: number;
  itemCount: number;
}

/**
 * Suggested prep time: median of recent confirmed -> ready durations, plus a minute per item
 * above the typical order size. Falls back to the merchant's configured prep time when there
 * is too little history.
 */
export function suggestPrepMinutes(
  samples: readonly PrepSample[],
  itemCount: number,
  fallbackMinutes: number,
): { minutes: number; basedOnHistory: boolean } {
  if (samples.length < ETA.minPrepSamples)
    return { minutes: fallbackMinutes, basedOnHistory: false };
  const m = median(samples.map((x) => x.minutes)) ?? fallbackMinutes;
  const typicalItems = median(samples.map((x) => x.itemCount)) ?? itemCount;
  const raw = m + Math.max(0, itemCount - typicalItems) * ETA.prepPerExtraItemMinutes;
  const minutes = Math.min(ETA.prepMaxMinutes, Math.max(ETA.prepMinMinutes, Math.round(raw)));
  return { minutes, basedOnHistory: true };
}
