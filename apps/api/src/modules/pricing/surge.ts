/** Pure surge resolution. Highest applicable multiplier wins, clamped to [10000, maxSurgeBps]. */
import { isOpenAt } from '@ebalangay/shared';
import { z } from 'zod';

export interface SurgeEventInput {
  multiplierBps: number;
  startsAt: Date;
  endsAt: Date | null;
}

export interface SurgeRuleInput {
  multiplierBps: number;
  /** manual | demand_ratio | weather | schedule */
  trigger: string;
  conditions: unknown;
  isActive: boolean;
}

export interface DemandSnapshot {
  /** Online, approved riders in the zone who are not on a delivery. */
  availableRiders: number;
  /** Zone orders waiting for a rider. */
  pendingOrders: number;
}

const hhmm = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/);
const scheduleConditions = z.object({
  /** Manila day of week, 0 = Sunday. Omitted = every day. */
  days: z.array(z.number().int().min(0).max(6)).optional(),
  start: hhmm,
  /** Earlier than start = runs past midnight. */
  end: hhmm,
});
const demandConditions = z.object({ minRatio: z.number().positive() });

export function demandRatio(d: DemandSnapshot): number {
  if (d.pendingOrders <= 0) return 0;
  return d.availableRiders <= 0 ? Number.POSITIVE_INFINITY : d.pendingOrders / d.availableRiders;
}

/** Does the rule apply now? Weather surges arrive as SurgeEvents, never as live rules. */
export function ruleApplies(rule: SurgeRuleInput, now: Date, demand: DemandSnapshot): boolean {
  if (!rule.isActive) return false;
  switch (rule.trigger) {
    case 'manual':
      return true;
    case 'schedule': {
      const c = scheduleConditions.safeParse(rule.conditions);
      if (!c.success) return false;
      const days = c.data.days ?? [0, 1, 2, 3, 4, 5, 6];
      return isOpenAt(
        days.map((dayOfWeek) => ({ dayOfWeek, opensAt: c.data.start, closesAt: c.data.end })),
        now,
      );
    }
    case 'demand_ratio': {
      const c = demandConditions.safeParse(rule.conditions);
      return c.success && demandRatio(demand) >= c.data.minRatio;
    }
    default:
      return false;
  }
}

export function resolveSurgeBps(input: {
  now: Date;
  events: readonly SurgeEventInput[];
  rules: readonly SurgeRuleInput[];
  demand: DemandSnapshot;
  maxSurgeBps: number;
}): number {
  let best = 10_000;
  for (const e of input.events) {
    if (e.startsAt <= input.now && (e.endsAt === null || input.now < e.endsAt)) {
      best = Math.max(best, e.multiplierBps);
    }
  }
  for (const r of input.rules) {
    if (ruleApplies(r, input.now, input.demand)) best = Math.max(best, r.multiplierBps);
  }
  return Math.min(best, input.maxSurgeBps);
}
