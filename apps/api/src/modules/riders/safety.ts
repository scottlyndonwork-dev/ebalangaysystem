import { Rooms, SocketEvent } from '@ebalangay/shared';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db, Tx } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { writeEvent } from '../../lib/outbox.js';
import { loadSettings } from '../../lib/settings.js';
import type { RedisClient } from '../../redis.js';
import { lastSeen } from '../tracking/location.js';

const minutes = z
  .number()
  .int()
  .min(1)
  .max(24 * 60);

/** Rider safety knobs (platform_settings rows, snake_case keys). */
export const safetySettingsSchema = z.object({
  /** Online this long in a shift without a passed helmet selfie: remind once. */
  safetySelfieReminderMinutes: minutes,
  /** ...and this long: set the rider offline (only while not on a delivery). */
  safetyAutoOfflineMinutes: minutes,
  /** Active delivery with no GPS ping for this long: alert ops. */
  safetyGpsStaleMinutes: minutes,
});
export type SafetySettings = z.infer<typeof safetySettingsSchema>;

export const DEFAULT_SAFETY_SETTINGS: SafetySettings = {
  safetySelfieReminderMinutes: 15,
  safetyAutoOfflineMinutes: 30,
  safetyGpsStaleMinutes: 10,
};

export const loadSafetySettings = (db: Db | Tx) =>
  loadSettings(db, safetySettingsSchema, DEFAULT_SAFETY_SETTINGS);

export const SAFETY_BATCH_SIZE = 200;
export const HELMET_SELFIE = 'helmet_selfie';
const ACTIVE_DELIVERY = ['assigned', 'at_merchant', 'picked_up'] as const;
const MARKER_TTL_S = 24 * 3600;
/** Re-alert a delivery that is still dark after this long. */
const GPS_ALERT_TTL_S = 30 * 60;
export const SafetyKeys = {
  reminded: (shiftId: string) => `safety:reminded:${shiftId}`,
  noGps: (deliveryId: string) => `ops:alert:no_gps:${deliveryId}`,
};

export interface SafetyResult {
  reminders: number;
  autoOffline: number;
  gpsAlerts: number;
}

const ago = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);
const minutesSince = (now: Date, t: Date) =>
  Math.max(0, Math.floor((now.getTime() - t.getTime()) / 60_000));

/** Claims a once-only Redis marker (deleted again by the caller if its write fails). */
async function claim(redis: RedisClient, key: string, ttl: number) {
  return (await redis.set(key, '1', 'EX', ttl, 'NX')) === 'OK';
}

/**
 * Every minute: helmet-selfie reminders and auto-offline for open shifts, plus an ops alert
 * for active deliveries whose rider stopped sending GPS.
 */
export async function monitorSafety(
  deps: { db: Db; redis: RedisClient; log?: Logger },
  now = new Date(),
): Promise<SafetyResult> {
  const { db, redis } = deps;
  const s = await loadSafetySettings(db);
  const result: SafetyResult = { reminders: 0, autoOffline: 0, gpsAlerts: 0 };

  // Open shifts of riders still working, with no passed helmet selfie in the shift.
  const shifts = await db.riderShift.findMany({
    where: {
      endedAt: null,
      startedAt: { lt: ago(now, s.safetySelfieReminderMinutes) },
      rider: { status: { in: ['online', 'on_delivery'] } },
      safetyChecks: { none: { type: HELMET_SELFIE, passed: true } },
    },
    select: {
      id: true,
      startedAt: true,
      rider: { select: { id: true, userId: true, status: true } },
    },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    take: SAFETY_BATCH_SIZE,
  });

  for (const shift of shifts) {
    const online = minutesSince(now, shift.startedAt);
    const { rider } = shift;
    if (online >= s.safetyAutoOfflineMinutes && rider.status === 'online') {
      if (await setOffline(db, shift, online, now)) result.autoOffline++;
      continue;
    }
    // Riders on a delivery past the deadline get the reminder; offline waits until they are free.
    const key = SafetyKeys.reminded(shift.id);
    if (!(await claim(redis, key, MARKER_TTL_S))) continue;
    try {
      await db.$transaction((tx) =>
        writeEvent(tx, {
          event: SocketEvent.RIDER_SAFETY,
          // Keyed by shift: reminder = v0, auto-offline = v1 (clients drop versions they've seen).
          aggregateType: 'rider_shift',
          aggregateId: shift.id,
          version: 0,
          data: { riderId: rider.id, shiftId: shift.id, kind: 'helmet_reminder', minutes: online },
          rooms: [Rooms.rider(rider.id)],
          push: {
            userIds: [rider.userId],
            titleKey: 'notifications:helmetSelfieReminder.title',
            bodyKey: 'notifications:helmetSelfieReminder.body',
            params: { minutes: Math.max(0, s.safetyAutoOfflineMinutes - online) },
            category: 'system',
            app: 'rider',
            dedupeKey: `shift:${shift.id}:helmet_reminder`,
          },
          occurredAt: now,
        }),
      );
      result.reminders++;
    } catch (err) {
      await redis.del(key);
      throw err;
    }
  }

  result.gpsAlerts = await alertDarkDeliveries(deps, s, now);
  if (result.autoOffline || result.gpsAlerts) deps.log?.warn(result, 'rider safety actions');
  return result;
}

async function setOffline(
  db: Db,
  shift: { id: string; startedAt: Date; rider: { id: string; userId: string } },
  online: number,
  now: Date,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    // Guarded: a rider who just took a job (on_delivery) or went offline is left alone.
    const updated = await tx.rider.updateMany({
      where: { id: shift.rider.id, status: 'online' },
      data: { status: 'offline', version: { increment: 1 } },
    });
    if (!updated.count) return false;
    const ended = await tx.riderShift.updateMany({
      where: { id: shift.id, endedAt: null },
      data: {
        endedAt: now,
        onlineSeconds: Math.floor((now.getTime() - shift.startedAt.getTime()) / 1000),
      },
    });
    if (!ended.count) throw new Error('shift ended concurrently');
    await writeAudit(tx, null, {
      action: 'rider.safety.auto_offline',
      actorRole: 'system',
      targetType: 'rider',
      targetId: shift.rider.id,
      metadata: { shiftId: shift.id, minutesWithoutSelfie: online },
    });
    await writeEvent(tx, {
      event: SocketEvent.RIDER_SAFETY,
      aggregateType: 'rider_shift',
      aggregateId: shift.id,
      version: 1,
      data: { riderId: shift.rider.id, shiftId: shift.id, kind: 'auto_offline', minutes: online },
      rooms: [Rooms.rider(shift.rider.id), Rooms.admin()],
      push: {
        userIds: [shift.rider.userId],
        titleKey: 'notifications:safetyAutoOffline.title',
        bodyKey: 'notifications:safetyAutoOffline.body',
        category: 'system',
        app: 'rider',
        dedupeKey: `shift:${shift.id}:auto_offline`,
      },
      occurredAt: now,
    });
    return true;
  });
}

async function alertDarkDeliveries(
  deps: { db: Db; redis: RedisClient },
  s: SafetySettings,
  now: Date,
): Promise<number> {
  const cutoff = ago(now, s.safetyGpsStaleMinutes);
  const deliveries = await deps.db.delivery.findMany({
    where: {
      status: { in: [...ACTIVE_DELIVERY] },
      riderId: { not: null },
      // Grace after assignment for the first ping.
      assignedAt: { lt: cutoff },
    },
    select: {
      id: true,
      riderId: true,
      assignedAt: true,
      legs: { select: { orderId: true } },
    },
    orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
    take: SAFETY_BATCH_SIZE,
  });

  let alerts = 0;
  for (const d of deliveries) {
    const riderId = d.riderId as string;
    const seen = await lastSeen(deps.redis, riderId);
    if (seen && seen.at >= cutoff) continue;
    const key = SafetyKeys.noGps(d.id);
    if (!(await claim(deps.redis, key, GPS_ALERT_TTL_S))) continue;
    const since = seen?.at ?? d.assignedAt ?? now;
    try {
      await deps.db.$transaction((tx) =>
        writeEvent(tx, {
          event: SocketEvent.ADMIN_RIDER_ALERT,
          aggregateType: 'delivery',
          aggregateId: d.id,
          // Re-alerts for the same delivery must look newer: epoch minute.
          version: Math.floor(now.getTime() / 60_000),
          data: {
            riderId,
            deliveryId: d.id,
            orderIds: [...new Set(d.legs.map((l) => l.orderId))],
            kind: 'no_gps',
            minutes: minutesSince(now, since),
            lastSeenAt: seen ? seen.at.toISOString() : null,
          },
          rooms: [Rooms.admin()],
          occurredAt: now,
        }),
      );
      alerts++;
    } catch (err) {
      await deps.redis.del(key);
      throw err;
    }
  }
  return alerts;
}
