import {
  type MenuScheduleRule,
  parseTimeOfDay,
  Rooms,
  SocketEvent,
  toManilaParts,
} from '@ebalangay/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, Tx } from '../../db.js';
import { writeEvent } from '../../lib/outbox.js';
import type { RedisClient } from '../../redis.js';

/**
 * Read-through cache of each merchant's active menu schedules for the browse paths. Schedule
 * writes invalidate it; the TTL bounds staleness if an invalidation is lost. Cart lines and
 * checkout read Postgres directly, so a stale cache can never let an order through.
 */
export const MENU_CACHE_TTL_S = 3600;
export const menuCacheKey = (merchantId: string) => `menu:schedules:${merchantId}`;
export const MENU_BOUNDARY_CURSOR_KEY = 'menu:boundary:last';
/** After downtime, boundaries older than this are not announced (clients refetch anyway). */
export const MENU_BOUNDARY_CATCHUP_MINUTES = 15;

export type CachedRule = MenuScheduleRule & { id: string };
/** Pino logger or a request's logger. */
type Log = Pick<FastifyBaseLogger, 'warn' | 'debug'>;

async function loadRules(db: Db | Tx, merchantIds: string[]): Promise<Map<string, CachedRule[]>> {
  const rows = await db.menuSchedule.findMany({
    where: { merchantId: { in: merchantIds }, isActive: true },
    select: {
      id: true,
      merchantId: true,
      dayOfWeek: true,
      startTime: true,
      endTime: true,
      productIds: true,
      categoryIds: true,
      isActive: true,
    },
  });
  const by = new Map<string, CachedRule[]>(merchantIds.map((id) => [id, []]));
  for (const { merchantId, ...rule } of rows) by.get(merchantId)?.push(rule);
  return by;
}

/** Same shape as browse's loadSchedules, served from Redis when possible. */
export async function cachedSchedules(
  db: Db | Tx,
  redis: RedisClient,
  merchantIds: string[],
  log?: Log,
): Promise<(merchantId: string) => CachedRule[]> {
  const ids = [...new Set(merchantIds)];
  const by = new Map<string, CachedRule[]>();
  if (!ids.length) return () => [];
  let cached: (string | null)[] = [];
  try {
    cached = await redis.mget(ids.map(menuCacheKey));
  } catch (err) {
    log?.warn({ err }, 'menu cache read failed');
  }
  const misses: string[] = [];
  ids.forEach((id, i) => {
    const hit = cached[i];
    if (hit) by.set(id, JSON.parse(hit) as CachedRule[]);
    else misses.push(id);
  });
  if (misses.length) {
    const loaded = await loadRules(db, misses);
    const pipe = redis.multi();
    for (const [id, rules] of loaded) {
      by.set(id, rules);
      pipe.set(menuCacheKey(id), JSON.stringify(rules), 'EX', MENU_CACHE_TTL_S);
    }
    await pipe.exec().catch((err: unknown) => log?.warn({ err }, 'menu cache write failed'));
  }
  return (merchantId) => by.get(merchantId) ?? [];
}

/** Call after a schedule write commits. */
export async function invalidateMenuCache(
  redis: RedisClient,
  merchantId: string,
  log?: Log,
): Promise<void> {
  await redis.del(menuCacheKey(merchantId)).catch((err: unknown) => {
    log?.warn({ err, merchantId }, 'menu cache invalidation failed');
  });
}

export interface ScheduleBoundary {
  scheduleId: string;
  merchantId: string;
  kind: 'start' | 'end';
}

const DAY_MINUTES = 24 * 60;

/** Schedules whose window starts or ends exactly at this Manila minute. */
export function boundariesAt(
  schedules: readonly {
    id: string;
    merchantId: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
  }[],
  minute: Date,
): ScheduleBoundary[] {
  const { dayOfWeek, hour, minute: mm } = toManilaParts(minute);
  const now = hour * 60 + mm;
  const out: ScheduleBoundary[] = [];
  for (const s of schedules) {
    const start = parseTimeOfDay(s.startTime);
    const end = parseTimeOfDay(s.endTime);
    if (s.dayOfWeek === dayOfWeek && start === now)
      out.push({ scheduleId: s.id, merchantId: s.merchantId, kind: 'start' });
    // Overnight windows (end <= start) and "24:00" end on the next day.
    const endDay = end <= start || end === DAY_MINUTES ? (s.dayOfWeek + 1) % 7 : s.dayOfWeek;
    if (endDay === dayOfWeek && end % DAY_MINUTES === now)
      out.push({ scheduleId: s.id, merchantId: s.merchantId, kind: 'end' });
  }
  return out;
}

/**
 * Every minute: for menu windows opening or closing since the last run, refresh those merchants'
 * cache entries and send `merchant.menu_changed`. The version is the boundary's epoch minute, so
 * it only ever grows per merchant.
 */
export async function menuBoundaryTick(
  deps: { db: Db; redis: RedisClient; log?: Log },
  now = new Date(),
): Promise<{ minutes: number; merchants: number }> {
  const { db, redis } = deps;
  const current = Math.floor(now.getTime() / 60_000);
  const last = Number(await redis.get(MENU_BOUNDARY_CURSOR_KEY));
  const from =
    Number.isFinite(last) && last > 0
      ? Math.max(last + 1, current - MENU_BOUNDARY_CATCHUP_MINUTES)
      : current;
  if (from > current) return { minutes: 0, merchants: 0 };

  const minutes: Date[] = [];
  for (let m = from; m <= current; m++) minutes.push(new Date(m * 60_000));
  const days = new Set<number>();
  for (const d of minutes) {
    const dow = toManilaParts(d).dayOfWeek;
    days.add(dow).add((dow + 6) % 7);
  }
  const schedules = await db.menuSchedule.findMany({
    where: { isActive: true, dayOfWeek: { in: [...days] } },
    select: { id: true, merchantId: true, dayOfWeek: true, startTime: true, endTime: true },
  });

  const byMerchant = new Map<string, { minute: number; changes: ScheduleBoundary[] }>();
  for (const d of minutes) {
    for (const b of boundariesAt(schedules, d)) {
      const entry = byMerchant.get(b.merchantId) ?? { minute: 0, changes: [] };
      entry.minute = Math.max(entry.minute, d.getTime() / 60_000);
      entry.changes.push(b);
      byMerchant.set(b.merchantId, entry);
    }
  }

  if (byMerchant.size) {
    await redis.del(...[...byMerchant.keys()].map(menuCacheKey));
    await db.$transaction(async (tx) => {
      for (const [merchantId, { minute, changes }] of byMerchant) {
        await writeEvent(tx, {
          event: SocketEvent.MERCHANT_MENU_CHANGED,
          aggregateType: 'merchant',
          aggregateId: merchantId,
          version: minute,
          data: {
            merchantId,
            changes: changes.map(({ scheduleId, kind }) => ({ scheduleId, kind })),
          },
          rooms: [Rooms.merchant(merchantId)],
          occurredAt: new Date(minute * 60_000),
        });
      }
    });
  }
  await redis.set(MENU_BOUNDARY_CURSOR_KEY, String(current));
  if (byMerchant.size) deps.log?.debug({ merchants: byMerchant.size }, 'menu boundaries');
  return { minutes: minutes.length, merchants: byMerchant.size };
}
