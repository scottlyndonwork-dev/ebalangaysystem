import { getServerT } from '@ebalangay/i18n/server';
import { type Notification as NotificationDto, Rooms, SocketEvent } from '@ebalangay/shared';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { Db } from '../../db.js';
import type { Notification, Prisma } from '../../generated/prisma/client.js';
import type { PushSender } from '../../lib/push.js';
import type { SmsSender } from '../../lib/sms.js';
import type { RedisClient } from '../../redis.js';
import type { PushJob } from './payload.js';

/** How long a "push/SMS already sent for this dedupe key" marker lives. */
export const SENT_MARKER_TTL_S = 7 * 24 * 3600;
/** Expo publishes receipts within ~15 min and keeps them 24h. */
export const RECEIPT_CHECK_DELAY_MS = 15 * 60_000;
export const RECEIPTS_JOB = 'push-receipts';

export interface NotifyDeps {
  db: Db;
  redis: RedisClient;
  push: PushSender;
  sms: SmsSender;
  /** The notifications queue (receipt checks are enqueued on it). */
  queue: Queue;
  log: Logger;
}

export interface ReceiptsJob {
  tickets: { id: string; token: string }[];
}

export interface DeliveryResult {
  users: number;
  inApp: number;
  push: number;
  sms: number;
}

export function toNotificationDto(n: Notification): NotificationDto {
  return {
    id: n.id,
    userId: n.userId,
    type: n.type,
    title: n.title,
    body: n.body,
    data: n.data as Record<string, string>,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

export const sentMarker = (userId: string, channel: 'push' | 'sms', dedupeKey: string) =>
  `notif:sent:${userId}:${channel}:${dedupeKey}`;

const ON = { push: true, sms: true, inApp: true };

type Translate = (key: string, params: Record<string, string | number>) => string;
/** i18n keys here come from outbox rows at runtime, so they can't be the typed literal keys. */
const translator = (locale: Parameters<typeof getServerT>[0]) =>
  getServerT(locale) as unknown as Translate;

/**
 * Delivers one push job to every recipient: in-app row (+ notification.created via the
 * outbox), Expo push to the target app's devices, and SMS for critical alerts, each gated by
 * the user's preference for the category and localized to user.locale.
 *
 * Retries are safe: the in-app row is unique per (user, dedupe key), and push/SMS set a Redis
 * marker after sending, so a retry only redoes the channels that didn't finish.
 */
export async function deliverPush(deps: NotifyDeps, job: PushJob): Promise<DeliveryResult> {
  const { db, redis, log } = deps;
  const category = job.category ?? 'order';
  const dedupeKey = job.dedupeKey ?? `event:${job.eventId}`;
  const users = await db.user.findMany({
    where: { id: { in: job.userIds }, status: 'active', deletedAt: null },
    select: {
      id: true,
      locale: true,
      phone: true,
      notificationPrefs: { where: { category }, select: { push: true, sms: true, inApp: true } },
    },
  });
  const devices = await db.userDevice.findMany({
    where: {
      userId: { in: users.map((u) => u.id) },
      pushToken: { not: null },
      ...(job.app ? { app: job.app } : {}),
    },
    select: { userId: true, pushToken: true },
  });
  const data: Record<string, string> = {
    event: job.event,
    ...(job.entityType && job.entityId
      ? { entityType: job.entityType, entityId: job.entityId }
      : {}),
    ...(job.entityType === 'order' && job.entityId ? { orderId: job.entityId } : {}),
  };

  const res: DeliveryResult = { users: users.length, inApp: 0, push: 0, sms: 0 };
  const failures: Error[] = [];
  for (const u of users) {
    try {
      const t = translator(u.locale);
      const params = job.params ?? {};
      const title = t(job.titleKey, params).slice(0, 120);
      const body = t(job.bodyKey, params).slice(0, 500);
      const pref = u.notificationPrefs[0] ?? ON;

      if (pref.inApp && (await createInApp(db, u.id, category, title, body, data, dedupeKey))) {
        res.inApp++;
      }

      const pushKey = sentMarker(u.id, 'push', dedupeKey);
      if (pref.push && !(await redis.exists(pushKey))) {
        const tokens = devices
          .filter((d) => d.userId === u.id && d.pushToken && deps.push.isValidToken(d.pushToken))
          .map((d) => d.pushToken as string);
        if (tokens.length) {
          await sendPush(deps, job.eventId, u.id, tokens, { title, body, data });
          res.push++;
        }
        await redis.set(pushKey, '1', 'EX', SENT_MARKER_TTL_S);
      }

      const smsKey = sentMarker(u.id, 'sms', dedupeKey);
      if (job.smsKey && pref.sms && u.phone && !(await redis.exists(smsKey))) {
        await deps.sms.send(u.phone, t(job.smsKey, params));
        await redis.set(smsKey, '1', 'EX', SENT_MARKER_TTL_S);
        res.sms++;
      }
    } catch (err) {
      log.warn({ err, eventId: job.eventId, userId: u.id }, 'notification delivery failed');
      failures.push(err as Error);
    }
  }
  // Retry the whole job; finished users/channels are skipped by the dedupe key and markers.
  if (failures.length) {
    throw new Error(`delivery failed for ${failures.length} user(s): ${failures[0]?.message}`);
  }
  return res;
}

/** Returns false when this user already has a notification with this dedupe key. */
async function createInApp(
  db: Db,
  userId: string,
  type: Notification['type'],
  title: string,
  body: string,
  data: Record<string, string>,
  dedupeKey: string,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const [n] = await tx.notification.createManyAndReturn({
      data: [{ userId, type, title, body, data, dedupeKey }],
      skipDuplicates: true,
    });
    if (!n) return false;
    await tx.outboxEvent.create({
      data: {
        event: SocketEvent.NOTIFICATION_CREATED,
        aggregateType: 'notification',
        aggregateId: n.id,
        version: 1,
        payload: {
          id: n.id,
          version: 1,
          occurredAt: n.createdAt.toISOString(),
          data: toNotificationDto(n),
        } as Prisma.InputJsonValue,
        rooms: [Rooms.user(userId)],
      },
    });
    return true;
  });
}

async function sendPush(
  deps: NotifyDeps,
  eventId: string,
  userId: string,
  tokens: string[],
  msg: { title: string; body: string; data: Record<string, string> },
): Promise<void> {
  const outcomes = await deps.push.send(tokens.map((to) => ({ to, ...msg })));
  const dead: string[] = [];
  const tickets: ReceiptsJob['tickets'] = [];
  outcomes.forEach((o, i) => {
    const token = tokens[i] as string;
    if (o.ok && o.receiptId) tickets.push({ id: o.receiptId, token });
    else if (!o.ok && o.deviceGone) dead.push(token);
    else if (!o.ok) deps.log.warn({ userId, error: o.error }, 'push ticket error');
  });
  if (dead.length) await clearTokens(deps.db, dead);
  if (tickets.length) {
    const receipts: ReceiptsJob = { tickets };
    await deps.queue.add(RECEIPTS_JOB, receipts, {
      delay: RECEIPT_CHECK_DELAY_MS,
      jobId: `receipts-${eventId}-${userId}`,
    });
  }
}

const clearTokens = (db: Db, tokens: string[]) =>
  db.userDevice.updateMany({ where: { pushToken: { in: tokens } }, data: { pushToken: null } });

/** Clears tokens that Expo reports as no longer registered. */
export async function checkReceipts(
  deps: Pick<NotifyDeps, 'db' | 'push'>,
  job: ReceiptsJob,
): Promise<{ checked: number; cleared: number }> {
  const outcomes = await deps.push.receipts(job.tickets.map((t) => t.id));
  const dead = job.tickets
    .filter((t) => {
      const o = outcomes[t.id];
      return o && !o.ok && o.deviceGone;
    })
    .map((t) => t.token);
  const cleared = dead.length ? (await clearTokens(deps.db, dead)).count : 0;
  return { checked: Object.keys(outcomes).length, cleared };
}
