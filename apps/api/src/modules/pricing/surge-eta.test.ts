import { describe, expect, it } from 'vitest';
import { dispatchMinutes, estimateEta, median, suggestPrepMinutes, travelMinutes } from './eta.js';
import { demandRatio, resolveSurgeBps, ruleApplies, type SurgeRuleInput } from './surge.js';

// Wednesday 2026-11-18 12:00 Manila
const NOON = new Date('2026-11-18T04:00:00Z');
const calm = { availableRiders: 5, pendingOrders: 1 };
const rule = (over: Partial<SurgeRuleInput>): SurgeRuleInput => ({
  multiplierBps: 13_000,
  trigger: 'manual',
  conditions: {},
  isActive: true,
  ...over,
});

describe('surge', () => {
  it('demand ratio: pending per available rider; infinite with no riders', () => {
    expect(demandRatio({ availableRiders: 4, pendingOrders: 6 })).toBe(1.5);
    expect(demandRatio({ availableRiders: 0, pendingOrders: 1 })).toBe(Infinity);
    expect(demandRatio({ availableRiders: 0, pendingOrders: 0 })).toBe(0);
  });

  it('manual rules apply while active', () => {
    expect(ruleApplies(rule({}), NOON, calm)).toBe(true);
    expect(ruleApplies(rule({ isActive: false }), NOON, calm)).toBe(false);
  });

  it('schedule rules use Manila day + time, incl. overnight windows', () => {
    const lunch = rule({ trigger: 'schedule', conditions: { start: '11:00', end: '13:00' } });
    expect(ruleApplies(lunch, NOON, calm)).toBe(true);
    expect(ruleApplies(lunch, new Date('2026-11-18T06:00:00Z'), calm)).toBe(false);
    const weekend = rule({
      trigger: 'schedule',
      conditions: { days: [0, 6], start: '11:00', end: '13:00' },
    });
    expect(ruleApplies(weekend, NOON, calm)).toBe(false);
    const late = rule({
      trigger: 'schedule',
      conditions: { days: [2], start: '22:00', end: '02:00' },
    });
    // Wed 01:00 Manila belongs to Tuesday's overnight window
    expect(ruleApplies(late, new Date('2026-11-17T17:00:00Z'), calm)).toBe(true);
  });

  it('demand rules trigger at the min ratio', () => {
    const busy = rule({ trigger: 'demand_ratio', conditions: { minRatio: 2 } });
    expect(ruleApplies(busy, NOON, { availableRiders: 2, pendingOrders: 3 })).toBe(false);
    expect(ruleApplies(busy, NOON, { availableRiders: 2, pendingOrders: 4 })).toBe(true);
    expect(ruleApplies(busy, NOON, { availableRiders: 0, pendingOrders: 1 })).toBe(true);
  });

  it('ignores malformed conditions and unknown/weather triggers', () => {
    expect(
      ruleApplies(rule({ trigger: 'schedule', conditions: { start: '9am' } }), NOON, calm),
    ).toBe(false);
    expect(ruleApplies(rule({ trigger: 'demand_ratio', conditions: {} }), NOON, calm)).toBe(false);
    expect(ruleApplies(rule({ trigger: 'weather' }), NOON, calm)).toBe(false);
  });

  it('takes the highest active event or rule, capped', () => {
    const events = [
      { multiplierBps: 15_000, startsAt: new Date('2026-11-18T03:00:00Z'), endsAt: null },
      { multiplierBps: 30_000, startsAt: new Date('2026-11-18T05:00:00Z'), endsAt: null },
      { multiplierBps: 25_000, startsAt: new Date('2026-11-18T01:00:00Z'), endsAt: NOON },
    ];
    const base = { now: NOON, demand: calm, maxSurgeBps: 20_000 };
    expect(resolveSurgeBps({ ...base, events: [], rules: [] })).toBe(10_000);
    expect(resolveSurgeBps({ ...base, events, rules: [rule({})] })).toBe(15_000);
    expect(resolveSurgeBps({ ...base, events, rules: [rule({ multiplierBps: 18_000 })] })).toBe(
      18_000,
    );
    expect(resolveSurgeBps({ ...base, events: [], rules: [rule({ multiplierBps: 40_000 })] })).toBe(
      20_000,
    );
  });
});

describe('eta', () => {
  it('travel time: road factor at city speed, rounded up', () => {
    expect(travelMinutes(0)).toBe(0);
    expect(travelMinutes(2_000)).toBe(8);
    expect(travelMinutes(10_000)).toBe(39);
  });

  it('dispatch wait grows with demand and is capped', () => {
    expect(dispatchMinutes({ availableRiders: 5, pendingOrders: 0 })).toBe(2);
    expect(dispatchMinutes({ availableRiders: 2, pendingOrders: 3 })).toBe(7);
    expect(dispatchMinutes({ availableRiders: 1, pendingOrders: 50 })).toBe(25);
    expect(dispatchMinutes({ availableRiders: 0, pendingOrders: 0 })).toBe(20);
  });

  it('pickup waits for the longer of prep and rider arrival', () => {
    expect(estimateEta({ prepMinutes: 20, distanceM: 2_000, demand: calm })).toEqual({
      minutes: 20 + 8 + 3,
      minMinutes: 26,
      maxMinutes: 38,
    });
    // Quick prep, no riders: rider wait (20 + 6) dominates
    expect(
      estimateEta({
        prepMinutes: 5,
        distanceM: 2_000,
        demand: { availableRiders: 0, pendingOrders: 0 },
      }).minutes,
    ).toBe(26 + 8 + 3);
  });

  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('suggested prep: history median + per extra item, else fallback', () => {
    const few = [{ minutes: 10, itemCount: 2 }];
    expect(suggestPrepMinutes(few, 3, 20)).toEqual({ minutes: 20, basedOnHistory: false });
    const hist = [12, 15, 18, 14, 16].map((minutes) => ({ minutes, itemCount: 2 }));
    expect(suggestPrepMinutes(hist, 2, 20)).toEqual({ minutes: 15, basedOnHistory: true });
    expect(suggestPrepMinutes(hist, 6, 20).minutes).toBe(19);
    expect(suggestPrepMinutes(hist, 1, 20).minutes).toBe(15);
    const slow = hist.map((h) => ({ ...h, minutes: 500 }));
    expect(suggestPrepMinutes(slow, 2, 20).minutes).toBe(120);
  });
});
