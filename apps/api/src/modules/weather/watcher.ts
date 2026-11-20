import {
  RAINFALL_LEVEL,
  Rooms,
  SocketEvent,
  type WeatherReading,
  weatherRuleConditionsSchema,
} from '@ebalangay/shared';
import type { Logger } from 'pino';
import type { Db, Tx } from '../../db.js';
import { writeEvent } from '../../lib/outbox.js';
import { loadZonePricing } from '../pricing/context.js';
import { loadPricingSettings } from '../pricing/settings.js';
import { validReadings, type WeatherFeed } from './feed.js';

export const WeatherReason = {
  FEED: 'weather:feed',
  MANUAL: 'weather:manual',
} as const;
/** Feed surges last 3 polls past the last matching reading, so a dead feed can't pin a surge. */
export const WEATHER_EVENT_TTL_MS = 45 * 60_000;
/** Older readings count as no data for that zone. */
export const MAX_READING_AGE_MS = 60 * 60_000;

export interface WeatherResult {
  /** No feed data this poll. */
  skipped: boolean;
  started: number;
  extended: number;
  ended: number;
}

/** Does this reading meet a weather rule's thresholds? Bad conditions never match. */
export function weatherMatches(conditions: unknown, r: WeatherReading): boolean {
  const c = weatherRuleConditionsSchema.safeParse(conditions);
  if (!c.success) return false;
  const rain =
    c.data.minRainfall !== undefined &&
    RAINFALL_LEVEL[r.rainfall] >= RAINFALL_LEVEL[c.data.minRainfall];
  const wind = c.data.minCycloneSignal !== undefined && r.cycloneSignal >= c.data.minCycloneSignal;
  return rain || wind;
}

export async function zoneSurgeBps(tx: Tx, zoneId: string, now: Date): Promise<number> {
  const pricing = await loadZonePricing(tx, zoneId, now, await loadPricingSettings(tx));
  return pricing?.surgeBps ?? 10_000;
}

/** The zone's resolved surge after a change, to riders in the zone room. */
export async function emitZoneSurge(tx: Tx, zoneId: string, now: Date): Promise<number> {
  const surgeBps = await zoneSurgeBps(tx, zoneId, now);
  await writeEvent(tx, {
    event: SocketEvent.SURGE_UPDATED,
    aggregateType: 'zone_surge',
    aggregateId: zoneId,
    // Surge has no row of its own; seconds keep later changes newer.
    version: Math.floor(now.getTime() / 1000),
    data: { surgeBps },
    rooms: [Rooms.zone(zoneId)],
    occurredAt: now,
  });
  return surgeBps;
}

/**
 * Every 15 min: open, extend or end feed surges for active `weather` rules. A zone the feed
 * reports on is authoritative (clear = end its feed surges); a zone it is silent on is left to
 * expire. Admin-triggered surges are never touched here.
 */
export async function watchWeather(
  deps: { db: Db; feed: WeatherFeed; log?: Logger },
  now = new Date(),
): Promise<WeatherResult> {
  const { db } = deps;
  const result: WeatherResult = { skipped: false, started: 0, extended: 0, ended: 0 };
  const rules = await db.surgeRule.findMany({
    where: { trigger: 'weather', isActive: true, zone: { isActive: true } },
    select: { id: true, zoneId: true, multiplierBps: true, conditions: true },
  });
  if (!rules.length) return result;

  const zoneIds = [...new Set(rules.map((r) => r.zoneId))];
  const raw = await deps.feed.current(zoneIds, now);
  if (raw === null) return { ...result, skipped: true };
  const fresh = validReadings(raw, deps.log).filter(
    (r) => now.getTime() - new Date(r.observedAt).getTime() <= MAX_READING_AGE_MS,
  );
  const byZone = new Map(fresh.map((r) => [r.zoneId, r]));
  const until = new Date(now.getTime() + WEATHER_EVENT_TTL_MS);

  for (const zoneId of zoneIds) {
    const reading = byZone.get(zoneId);
    if (!reading) continue;
    const zoneRules = rules.filter((r) => r.zoneId === zoneId);
    await db.$transaction(async (tx) => {
      const open = await tx.surgeEvent.findMany({
        where: {
          zoneId,
          reason: WeatherReason.FEED,
          ruleId: { in: zoneRules.map((r) => r.id) },
          endsAt: { gt: now },
        },
        select: { id: true, ruleId: true },
      });
      let changed = false;
      for (const rule of zoneRules) {
        const current = open.find((e) => e.ruleId === rule.id);
        if (weatherMatches(rule.conditions, reading)) {
          if (current) {
            await tx.surgeEvent.update({ where: { id: current.id }, data: { endsAt: until } });
            result.extended++;
          } else {
            await tx.surgeEvent.create({
              data: {
                zoneId,
                ruleId: rule.id,
                multiplierBps: rule.multiplierBps,
                reason: WeatherReason.FEED,
                startsAt: now,
                endsAt: until,
              },
            });
            result.started++;
            changed = true;
          }
        } else if (current) {
          await tx.surgeEvent.update({ where: { id: current.id }, data: { endsAt: now } });
          result.ended++;
          changed = true;
        }
      }
      if (changed) await emitZoneSurge(tx, zoneId, now);
    });
  }
  if (result.started || result.ended) deps.log?.info(result, 'weather surges updated');
  return result;
}
