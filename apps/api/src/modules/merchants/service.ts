import {
  type ClosedReason,
  type HolidayClosure,
  type MerchantProfile,
  type MerchantStatus,
  addManilaDays,
  manilaDateKey,
  storeAvailability,
} from '@ebalangay/shared';
import type { Db, Tx } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';

/** Prisma @db.Date → "YYYY-MM-DD" (stored as UTC midnight). */
export const dateKeyOf = (d: Date): string => d.toISOString().slice(0, 10);
/** "YYYY-MM-DD" → value for a @db.Date column. */
export const dateOfKey = (key: string): Date => new Date(`${key}T00:00:00Z`);

/** Everything needed to render a profile and compute availability. */
export function profileInclude(now = new Date()) {
  return {
    storeHours: { orderBy: [{ dayOfWeek: 'asc' }, { opensAt: 'asc' }] },
    // From yesterday: an overnight slot from yesterday can still be running.
    holidayClosures: {
      where: { date: { gte: dateOfKey(manilaDateKey(addManilaDays(now, -1))) } },
      orderBy: { date: 'asc' },
    },
    _count: { select: { followers: true } },
  } satisfies Prisma.MerchantInclude;
}

export type MerchantWithProfile = Prisma.MerchantGetPayload<{
  include: ReturnType<typeof profileInclude>;
}>;

export function availabilityOf(m: MerchantWithProfile, now = new Date()) {
  return storeAvailability(
    {
      status: m.status,
      weekly: m.storeHours,
      holidays: m.holidayClosures.map((h) => ({
        date: dateKeyOf(h.date),
        closed: h.closed,
        opensAt: h.opensAt,
        closesAt: h.closesAt,
      })),
      pausedUntil: m.pausedUntil,
      autoPausedReason: m.autoPausedReason,
    },
    now,
  );
}

export function holidayOf(h: MerchantWithProfile['holidayClosures'][number]): HolidayClosure {
  return {
    date: dateKeyOf(h.date),
    closed: h.closed,
    opensAt: h.opensAt,
    closesAt: h.closesAt,
    note: h.note,
  };
}

export function toProfile(m: MerchantWithProfile, now = new Date()): MerchantProfile {
  const a = availabilityOf(m, now);
  return {
    id: m.id,
    slug: m.slug,
    name: m.name,
    businessType: m.businessType,
    status: m.status as MerchantStatus,
    description: m.description,
    logoUrl: m.logoUrl,
    coverUrl: m.coverUrl,
    phone: m.phone,
    email: m.email,
    addressLine: m.addressLine,
    barangay: m.barangay,
    city: m.city,
    province: m.province,
    location: { lat: m.lat, lng: m.lng },
    zoneId: m.zoneId,
    ratingAverage: Number(m.ratingAverage),
    ratingCount: m.ratingCount,
    isOpen: a.isOpen,
    closedReason: a.closedReason as ClosedReason | null,
    closesInMinutes: a.closesInMinutes,
    prepTimeMinutes: m.prepTimeMinutes,
    minOrderCentavos: Number(m.minOrderCentavos),
    commissionBps: m.commissionBps,
    deliveryRadiusM: m.deliveryRadiusM,
    autoAccept: m.autoAccept,
    advanceOrderHours: m.advanceOrderHours,
    freeDelivery: m.freeDelivery,
    verifiedBadge: m.verifiedBadge,
    pausedUntil: m.pausedUntil?.toISOString() ?? null,
    pauseMessage: m.pauseMessage,
    autoPausedReason: m.autoPausedReason,
    avgResponseSeconds: m.avgResponseSeconds,
    followerCount: m._count.followers,
    applicationSubmittedAt: m.applicationSubmittedAt?.toISOString() ?? null,
    applicationReviewNote: m.applicationReviewNote,
    version: m.version,
    createdAt: m.createdAt.toISOString(),
  };
}

/** Points the merchant at the active zone covering its location (or none). */
export async function assignZone(tx: Tx | Db, merchantId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE merchants m SET zone_id = (
      SELECT z.id FROM zones z
      WHERE z.is_active AND z.polygon IS NOT NULL
        AND ST_Covers(z.polygon, ST_SetSRID(ST_MakePoint(m.lng, m.lat), 4326)::geography)
      ORDER BY z.created_at LIMIT 1)
    WHERE m.id = ${merchantId}::uuid`;
}

/** "Aling Nena's Store" → "aling-nenas-store-x7k2" (suffix keeps slugs unique without a lookup race). */
export function slugFor(name: string, suffix: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return `${base || 'store'}-${suffix}`;
}

/**
 * Rolling 30-day merchant response time: avg seconds from placed to confirmed. Merchants with
 * no confirmed orders in the window go back to null ("new store"). Run by the metrics job.
 */
export async function refreshMerchantResponseTimes(db: Db, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE merchants SET avg_response_seconds = NULL
      WHERE avg_response_seconds IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM orders o
          WHERE o.merchant_id = merchants.id AND o.placed_at >= ${since}
            AND o.confirmed_at IS NOT NULL)`;
    return tx.$executeRaw`
      UPDATE merchants m SET avg_response_seconds = s.avg_seconds
      FROM (
        SELECT merchant_id,
               ROUND(AVG(EXTRACT(EPOCH FROM (confirmed_at - placed_at))))::int AS avg_seconds
        FROM orders
        WHERE placed_at >= ${since} AND confirmed_at IS NOT NULL AND confirmed_at >= placed_at
        GROUP BY merchant_id
      ) s
      WHERE m.id = s.merchant_id
        AND m.avg_response_seconds IS DISTINCT FROM s.avg_seconds`;
  });
}
