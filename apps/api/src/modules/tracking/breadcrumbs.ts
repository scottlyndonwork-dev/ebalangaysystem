import { randomUUID } from 'node:crypto';
import type { Db } from '../../db.js';
import type { RedisClient } from '../../redis.js';
import { type Breadcrumb, LocationKeys, lastSeen } from './location.js';

/** Rows per flush; leftovers wait for the next run. */
export const FLUSH_BATCH_SIZE = 5000;
const LOCK_TTL_MS = 55_000;

export interface FlushResult {
  locked: boolean;
  breadcrumbs: number;
  riders: number;
}

/**
 * Moves queued breadcrumbs to Postgres and refreshes riders.last_* from Redis. Runs every 60s
 * in the worker. Rows are read, inserted, then trimmed: a crash before the trim re-inserts the
 * same ids next time, which skipDuplicates absorbs. A Redis lock keeps replicas from trimming
 * each other's batches.
 */
export async function flushBreadcrumbs(
  db: Db,
  redis: RedisClient,
  batchSize = FLUSH_BATCH_SIZE,
): Promise<FlushResult> {
  const token = randomUUID();
  const got = await redis.set(LocationKeys.flushLock, token, 'PX', LOCK_TTL_MS, 'NX');
  if (got !== 'OK') return { locked: false, breadcrumbs: 0, riders: 0 };
  try {
    const raw = await redis.lrange(LocationKeys.crumbs, 0, batchSize - 1);
    const rows = raw.flatMap((r) => {
      try {
        const c = JSON.parse(r) as Breadcrumb;
        return [{ ...c, recordedAt: new Date(c.recordedAt) }];
      } catch {
        return [];
      }
    });
    if (rows.length) {
      // Deliveries are never deleted while live; a crumb for a vanished one is just dropped.
      const known = new Set(
        (
          await db.delivery.findMany({
            where: { id: { in: [...new Set(rows.map((r) => r.deliveryId))] } },
            select: { id: true },
          })
        ).map((d) => d.id),
      );
      await db.deliveryBreadcrumb.createMany({
        data: rows.filter((r) => known.has(r.deliveryId)),
        skipDuplicates: true,
      });
    }
    if (raw.length) await redis.ltrim(LocationKeys.crumbs, raw.length, -1);

    const riderIds = await redis.spop(LocationKeys.dirty, 1000);
    for (const riderId of riderIds) {
      const seen = await lastSeen(redis, riderId);
      if (!seen) continue;
      // The geography column follows lat/lng via trigger.
      await db.rider.updateMany({
        where: {
          id: riderId,
          OR: [{ lastLocationAt: null }, { lastLocationAt: { lt: seen.at } }],
        },
        data: { lastLat: seen.lat, lastLng: seen.lng, lastLocationAt: seen.at },
      });
    }
    return { locked: true, breadcrumbs: rows.length, riders: riderIds.length };
  } finally {
    // Release only our own lock (it may have expired and been taken by another replica).
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
      1,
      LocationKeys.flushLock,
      token,
    );
  }
}
