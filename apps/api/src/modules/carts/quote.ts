/**
 * Loads everything priceOrder needs for a cart (catalog, delivery, buyer, voucher, zone) and runs
 * it. Shared by cart views, checkout quotes and order placement so all three agree.
 */
import type { AddressSnapshot, CartWarning, PricingIssue } from '@ebalangay/shared';
import type { Db, Tx } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import { zoneAt } from '../browse/service.js';
import { availabilityOf, type MerchantWithProfile, profileInclude } from '../merchants/service.js';
import { loadPrepMedians, loadZonePricing, type ZonePricing } from '../pricing/context.js';
import { type PriceQuote, priceOrder, type VoucherInput } from '../pricing/engine.js';
import { estimateEta } from '../pricing/eta.js';
import { loadPricingSettings, type PricingSettings } from '../pricing/settings.js';
import {
  LINE_PROBLEM_MESSAGES,
  type LineSelection,
  type ResolvedLine,
  resolveLines,
} from './lines.js';

export type AddressRow = NonNullable<Awaited<ReturnType<Db['address']['findFirst']>>>;

/** The caller's address by id, or their default (then most recent) when no id is given. */
export async function loadAddress(
  db: Db | Tx,
  userId: string,
  addressId: string | undefined,
): Promise<AddressRow | null> {
  if (addressId) {
    const a = await db.address.findFirst({ where: { id: addressId, userId, deletedAt: null } });
    if (!a) throw new AppError('NOT_FOUND', 'Address not found');
    return a;
  }
  return db.address.findFirst({
    where: { userId, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
  });
}

export function addressSnapshot(a: AddressRow): AddressSnapshot {
  return {
    label: a.label,
    recipientName: a.recipientName,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    barangay: a.barangay,
    city: a.city,
    province: a.province,
    postalCode: a.postalCode,
    location: { lat: a.lat, lng: a.lng },
    deliveryNotes: a.riderNotes,
  };
}

/** Metres from the store to the point, or null when the store doesn't deliver there. */
export async function deliveryDistance(
  db: Db | Tx,
  merchant: { id: string; zoneId: string | null },
  point: { lat: number; lng: number },
): Promise<number | null> {
  if (!merchant.zoneId) return null;
  if ((await zoneAt(db, point.lat, point.lng)) !== merchant.zoneId) return null;
  const [row] = await db.$queryRaw<{ distance: number; within: boolean }[]>`
    SELECT ST_Distance(m.location, eb_point(${point.lat}::float8, ${point.lng}::float8))::float8 AS distance,
      ST_DWithin(m.location, eb_point(${point.lat}::float8, ${point.lng}::float8), m.delivery_radius_m) AS within
    FROM merchants m WHERE m.id = ${merchant.id}::uuid AND m.location IS NOT NULL`;
  return row?.within ? Math.round(row.distance) : null;
}

/** A verified, active merchant's owner buys at wholesale tiers. */
export async function isWholesaleBuyer(db: Db | Tx, userId: string): Promise<boolean> {
  const n = await db.merchantStaff.count({
    where: {
      userId,
      isActive: true,
      rolePreset: 'owner',
      merchant: { status: 'active', verifiedBadge: true },
    },
  });
  return n > 0;
}

type VoucherRow = NonNullable<Awaited<ReturnType<Db['voucher']['findUnique']>>>;

export function toVoucherInput(v: VoucherRow): VoucherInput {
  return {
    id: v.id,
    code: v.code,
    discountType: v.discountType,
    amountCentavos: v.amountCentavos === null ? null : Number(v.amountCentavos),
    percentBps: v.percentBps,
    maxDiscountCentavos: v.maxDiscountCentavos === null ? null : Number(v.maxDiscountCentavos),
    minSpendCentavos: Number(v.minSpendCentavos),
    funding: v.funding,
    merchantId: v.merchantId,
    startsAt: v.startsAt,
    endsAt: v.endsAt,
    isActive: v.isActive,
    usageLimit: v.usageLimit,
    usedCount: v.usedCount,
    perUserLimit: v.perUserLimit,
    newUsersOnly: v.newUsersOnly,
  };
}

export const normalizeVoucherCode = (code: string) => code.trim().toUpperCase();

export const ISSUE_MESSAGES: Record<string, string> = {
  EMPTY_CART: 'Your cart is empty',
  BELOW_MIN_ORDER: 'Add more items to reach the store minimum',
  ITEM_UNAVAILABLE: 'Some items are unavailable; remove them to check out',
  STORE_CLOSED: 'The store is closed',
  ADDRESS_REQUIRED: 'Add a delivery address',
  OUT_OF_DELIVERY_ZONE: 'The store does not deliver to this address',
  VOUCHER_NOT_FOUND: 'Voucher not found',
  VOUCHER_INACTIVE: 'This voucher is no longer active',
  VOUCHER_NOT_STARTED: 'This voucher is not active yet',
  VOUCHER_EXPIRED: 'This voucher has expired',
  VOUCHER_WRONG_MERCHANT: 'This voucher is for a different store',
  VOUCHER_USAGE_LIMIT: 'This voucher has been fully used',
  VOUCHER_USER_LIMIT: 'You already used this voucher',
  VOUCHER_NEW_USERS_ONLY: 'This voucher is for first orders only',
  VOUCHER_MIN_SPEND: 'Spend more to use this voucher',
  VOUCHER_NOT_APPLICABLE: 'This voucher does not apply to this order',
  POINTS_CAPPED: 'Points were limited to the maximum allowed',
  TIP_CAPPED: 'Tip was limited to the maximum allowed',
};

export interface QuoteOptions {
  userId: string;
  merchant: MerchantWithProfile;
  selections: readonly LineSelection[];
  /** Null: price without delivery (cart views without an address, group member views). */
  address: AddressRow | null;
  /** True when checkout needs an address (ADDRESS_REQUIRED is raised without one). */
  requireAddress: boolean;
  voucherCode: string | null;
  usePoints?: number;
  tipCentavos?: number;
  roundUpDonation?: boolean;
  now: Date;
  /** Store hours are evaluated at this time (scheduled orders); defaults to now. */
  at?: Date;
}

export interface CartQuote {
  lines: ResolvedLine[];
  quote: PriceQuote;
  settings: PricingSettings;
  zone: ZonePricing | null;
  addressId: string | null;
  distanceM: number | null;
  etaMinutes: number | null;
  voucherId: string | null;
  issues: PricingIssue[];
  warnings: CartWarning[];
  canCheckout: boolean;
}

export async function loadMerchantForCart(db: Db | Tx, merchantId: string, now: Date) {
  const m = await db.merchant.findUnique({
    where: { id: merchantId },
    include: profileInclude(now),
  });
  if (m?.status !== 'active') throw new AppError('NOT_FOUND', 'Store not found');
  return m;
}

export async function quoteCart(db: Db | Tx, o: QuoteOptions): Promise<CartQuote> {
  const settings = await loadPricingSettings(db);
  const lines = await resolveLines(db, o.merchant.id, o.selections, o.at ?? o.now);
  const issues: PricingIssue[] = [];
  const add = (code: string, blocking: boolean) => {
    if (!issues.some((i) => i.code === code)) issues.push({ code, blocking });
  };

  if (lines.some((l) => l.problem)) add('ITEM_UNAVAILABLE', true);
  if (!availabilityOf(o.merchant, o.at ?? o.now).isOpen) add('STORE_CLOSED', true);

  // Delivery
  let distanceM: number | null = null;
  let zone: ZonePricing | null = null;
  if (o.address) {
    distanceM = await deliveryDistance(db, o.merchant, o.address);
    if (distanceM === null) add('OUT_OF_DELIVERY_ZONE', true);
    else if (o.merchant.zoneId) {
      zone = await loadZonePricing(db, o.merchant.zoneId, o.now, settings);
      if (!zone) {
        distanceM = null;
        add('OUT_OF_DELIVERY_ZONE', true);
      }
    }
  } else if (o.requireAddress) add('ADDRESS_REQUIRED', true);

  // Voucher + buyer
  let voucher: VoucherInput | null = null;
  if (o.voucherCode) {
    const v = await db.voucher.findUnique({ where: { code: o.voucherCode } });
    if (v) voucher = toVoucherInput(v);
    else add('VOUCHER_NOT_FOUND', false);
  }
  const points = await db.pointsAccount.findUnique({
    where: { userId: o.userId },
    select: { balance: true },
  });
  const completedOrderCount = await db.order.count({
    where: { customerId: o.userId, status: 'delivered' },
  });
  const voucherUses = voucher
    ? await db.voucherRedemption.count({ where: { voucherId: voucher.id, userId: o.userId } })
    : 0;
  const isWholesaleEligible = await isWholesaleBuyer(db, o.userId);

  const quote = priceOrder({
    now: o.now,
    lines: lines.filter((l) => !l.problem).map((l) => l.pricing),
    merchant: {
      id: o.merchant.id,
      commissionBps: o.merchant.commissionBps,
      minOrderCentavos: Number(o.merchant.minOrderCentavos),
      freeDelivery: o.merchant.freeDelivery,
    },
    delivery:
      zone && distanceM !== null ? { distanceM, zone: zone.fees, surgeBps: zone.surgeBps } : null,
    buyer: {
      isWholesaleEligible,
      pointsBalance: points?.balance ?? 0,
      walletBalanceCentavos: 0,
      completedOrderCount,
      voucherUses,
    },
    voucher,
    usePoints: o.usePoints ?? 0,
    useWallet: false,
    tipCentavos: o.tipCentavos ?? 0,
    roundUpDonation: o.roundUpDonation ?? false,
    settings,
  });
  for (const i of quote.issues) add(i.code, i.blocking);

  let etaMinutes: number | null = null;
  if (zone && distanceM !== null) {
    const prep = (await loadPrepMedians(db, [o.merchant.id], o.now)).get(o.merchant.id);
    etaMinutes = estimateEta({
      prepMinutes: prep ?? o.merchant.prepTimeMinutes,
      distanceM,
      demand: zone.demand,
    }).minutes;
  }

  const warnings: CartWarning[] = issues.map((i) => ({
    code: i.code,
    message: ISSUE_MESSAGES[i.code] ?? i.code,
  }));
  for (const l of lines) {
    if (l.problem) {
      warnings.push({
        code: l.problem,
        message: `${l.name}: ${LINE_PROBLEM_MESSAGES[l.problem]}`,
      });
    }
  }
  return {
    lines,
    quote,
    settings,
    zone,
    addressId: o.address?.id ?? null,
    distanceM,
    etaMinutes,
    voucherId: quote.voucher?.id ?? null,
    issues,
    warnings,
    canCheckout: !issues.some((i) => i.blocking),
  };
}

/**
 * Largest-remainder split of `total` by weight, so the parts always sum to `total`.
 * All-zero weights put everything on the first entry (the host). BigInt avoids overflow.
 */
export function splitByWeight(
  total: number,
  parts: readonly { id: string; weight: number }[],
): Map<string, number> {
  const out = new Map(parts.map((p) => [p.id, 0]));
  const [first] = parts;
  if (!first) return out;
  const items = parts.map((p, i) => ({ id: p.id, i, w: BigInt(Math.max(0, p.weight)) }));
  const sum = items.reduce((a, x) => a + x.w, 0n);
  if (sum === 0n) {
    out.set(first.id, total);
    return out;
  }
  const t = BigInt(total);
  let given = 0n;
  const rems = items.map((x) => {
    const num = t * x.w;
    given += num / sum;
    out.set(x.id, Number(num / sum));
    return { id: x.id, i: x.i, rem: num % sum };
  });
  // Biggest remainders first; ties keep input order. At most rems.length units are left.
  rems.sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const r of rems) {
    if (given >= t) break;
    out.set(r.id, (out.get(r.id) ?? 0) + 1);
    given += 1n;
  }
  return out;
}
