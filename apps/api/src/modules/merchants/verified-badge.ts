import { Rooms, SocketEvent } from '@ebalangay/shared';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db, Tx } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { writeEvent } from '../../lib/outbox.js';
import { loadSettings } from '../../lib/settings.js';
import { merchantStaffUserIds } from '../orders/transitions.js';

/** Verified badge rules (platform_settings rows, snake_case keys). */
export const badgeSettingsSchema = z.object({
  badgeWindowDays: z.number().int().min(7).max(365),
  badgeMinDelivered: z.number().int().min(1),
  /** Max share of placed orders the merchant cancelled, in basis points. */
  badgeMaxMerchantCancelBps: z.number().int().min(0).max(10_000),
  /** Minimum average rating x100 (450 = 4.50). */
  badgeMinRatingX100: z.number().int().min(100).max(500),
  badgeMinReviews: z.number().int().min(0),
  badgeMinTrustScore: z.number().int().min(0).max(100),
});
export type BadgeSettings = z.infer<typeof badgeSettingsSchema>;

export const DEFAULT_BADGE_SETTINGS: BadgeSettings = {
  badgeWindowDays: 90,
  badgeMinDelivered: 30,
  badgeMaxMerchantCancelBps: 500,
  badgeMinRatingX100: 450,
  badgeMinReviews: 10,
  badgeMinTrustScore: 70,
};

export const BADGE_BATCH_SIZE = 200;

export interface BadgeMetrics {
  status: string;
  trustScore: number;
  placed: number;
  delivered: number;
  merchantCancelled: number;
  reviews: number;
  /** Null without reviews. */
  rating: number | null;
}

export type BadgeCheck =
  | 'active'
  | 'min_delivered'
  | 'max_merchant_cancel'
  | 'min_rating'
  | 'min_reviews'
  | 'min_trust_score';

/** Checks the merchant fails; empty = qualifies. */
export function failedBadgeChecks(m: BadgeMetrics, s: BadgeSettings): BadgeCheck[] {
  const failed: BadgeCheck[] = [];
  if (m.status !== 'active') failed.push('active');
  if (m.delivered < s.badgeMinDelivered) failed.push('min_delivered');
  // Integer compare: cancelled / placed <= bps / 10000.
  if (m.merchantCancelled * 10_000 > s.badgeMaxMerchantCancelBps * m.placed)
    failed.push('max_merchant_cancel');
  if (m.reviews < s.badgeMinReviews) failed.push('min_reviews');
  if (m.rating === null || Math.round(m.rating * 100) < s.badgeMinRatingX100)
    failed.push('min_rating');
  if (m.trustScore < s.badgeMinTrustScore) failed.push('min_trust_score');
  return failed;
}

export interface BadgeResult {
  evaluated: number;
  granted: number;
  revoked: number;
}

interface Row {
  id: string;
  name: string;
  status: string;
  verified_badge: boolean;
  trust_score: number;
  placed: number;
  delivered: number;
  merchant_cancelled: number;
  reviews: number;
  rating: number | null;
}

/**
 * Weekly (Mon 03:00 PHT): grants the Verified badge to active merchants meeting every rule over
 * the window and revokes it from those that no longer do. Every change is audit-logged and the
 * merchant's staff are notified. POS sales don't count toward the order rules.
 */
export async function evaluateVerifiedBadges(
  deps: { db: Db; log?: Logger },
  now = new Date(),
): Promise<BadgeResult> {
  const { db } = deps;
  const s = await loadSettings(db, badgeSettingsSchema, DEFAULT_BADGE_SETTINGS);
  const since = new Date(now.getTime() - s.badgeWindowDays * 86_400_000);
  const result: BadgeResult = { evaluated: 0, granted: 0, revoked: 0 };
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows = await db.$queryRaw<Row[]>`
      SELECT m.id, m.name, m.status::text AS status, m.verified_badge, m.trust_score,
        COALESCE(o.placed, 0)::int AS placed,
        COALESCE(o.delivered, 0)::int AS delivered,
        COALESCE(o.merchant_cancelled, 0)::int AS merchant_cancelled,
        COALESCE(r.reviews, 0)::int AS reviews,
        r.rating::float8 AS rating
      FROM merchants m
      LEFT JOIN LATERAL (
        SELECT count(*) AS placed,
          count(*) FILTER (WHERE status = 'delivered') AS delivered,
          count(*) FILTER (WHERE status = 'cancelled' AND cancelled_by = 'merchant')
            AS merchant_cancelled
        FROM orders
        WHERE merchant_id = m.id AND type <> 'pos' AND placed_at >= ${since}::timestamptz
      ) o ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS reviews, avg(rating) AS rating
        FROM reviews
        WHERE merchant_id = m.id AND target = 'merchant' AND NOT is_hidden
          AND created_at >= ${since}::timestamptz
      ) r ON true
      WHERE m.id > ${after}::uuid AND (m.status = 'active' OR m.verified_badge)
      ORDER BY m.id
      LIMIT ${BADGE_BATCH_SIZE}`;

    for (const row of rows) {
      result.evaluated++;
      const metrics: BadgeMetrics = {
        status: row.status,
        trustScore: row.trust_score,
        placed: row.placed,
        delivered: row.delivered,
        merchantCancelled: row.merchant_cancelled,
        reviews: row.reviews,
        rating: row.rating,
      };
      const failed = failedBadgeChecks(metrics, s);
      const qualifies = failed.length === 0;
      if (qualifies === row.verified_badge) continue;
      const changed = await db.$transaction((tx) => setBadge(tx, row, qualifies, failed, metrics));
      if (!changed) continue;
      if (qualifies) result.granted++;
      else result.revoked++;
    }
    if (rows.length < BADGE_BATCH_SIZE) break;
    after = rows.at(-1)?.id ?? after;
  }
  if (result.granted || result.revoked) deps.log?.info(result, 'verified badges updated');
  return result;
}

async function setBadge(
  tx: Tx,
  row: Row,
  verifiedBadge: boolean,
  failed: BadgeCheck[],
  metrics: BadgeMetrics,
): Promise<boolean> {
  // Guarded: an admin may have changed it since the read.
  const { count } = await tx.merchant.updateMany({
    where: { id: row.id, verifiedBadge: !verifiedBadge },
    data: { verifiedBadge, version: { increment: 1 } },
  });
  if (count === 0) return false;
  const { version } = await tx.merchant.findUniqueOrThrow({
    where: { id: row.id },
    select: { version: true },
  });
  const action = verifiedBadge ? 'merchant.verified_badge.grant' : 'merchant.verified_badge.revoke';
  await writeAudit(tx, null, {
    action,
    actorRole: 'system',
    targetType: 'merchant',
    targetId: row.id,
    merchantId: row.id,
    metadata: { failed, ...metrics },
  });
  const key = verifiedBadge ? 'verifiedBadgeGranted' : 'verifiedBadgeRevoked';
  await writeEvent(tx, {
    event: SocketEvent.MERCHANT_BADGE_UPDATED,
    aggregateType: 'merchant',
    aggregateId: row.id,
    version,
    data: { merchantId: row.id, verifiedBadge, failed },
    rooms: [Rooms.merchant(row.id)],
    push: {
      userIds: await merchantStaffUserIds(tx, row.id),
      titleKey: `notifications:${key}.title`,
      bodyKey: `notifications:${key}.body`,
      params: { store: row.name },
      category: 'system',
      app: 'merchant',
      dedupeKey: `merchant:${row.id}:badge:${version}`,
    },
  });
  return true;
}
