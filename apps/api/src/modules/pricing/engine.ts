/**
 * Pure pricing engine: no DB, no clock. Every money value is integer centavos.
 * Callers (cart quote, checkout, POS) load the inputs and persist the outputs.
 *
 * Money identity (asserted in tests):
 *   total = merchantNet + riderEarning + platformNet + donation
 */
import {
  addCentavos,
  type PriceBreakdown,
  applyBasisPoints,
  type Centavos,
  multiplyCentavos,
  subtractCentavos,
} from '@ebalangay/shared';
import type { PricingSettings } from './settings.js';

export interface WholesaleTier {
  minQty: number;
  unitPriceCentavos: Centavos;
}

export interface PricingLineInput {
  /** Caller's id for the line (cart item id), echoed back. */
  key: string;
  /** Variant price when a variant is chosen, else the product base price. */
  unitPriceCentavos: Centavos;
  /** Price deltas of the chosen modifier options (may be negative). */
  modifierDeltasCentavos: readonly Centavos[];
  quantity: number;
  /** Tiers for this product/variant; used only for wholesale-eligible buyers. */
  wholesaleTiers?: readonly WholesaleTier[];
}

export interface DeliveryFeeTier {
  minDistanceM: number;
  maxDistanceM: number;
  feeCentavos: Centavos;
}

export interface ZoneFeeRules {
  baseDeliveryFeeCentavos: Centavos;
  perKmFeeCentavos: Centavos;
  tiers: readonly DeliveryFeeTier[];
}

export interface VoucherInput {
  id: string;
  code: string;
  discountType: 'fixed' | 'percent' | 'free_delivery';
  amountCentavos: Centavos | null;
  percentBps: number | null;
  maxDiscountCentavos: Centavos | null;
  minSpendCentavos: Centavos;
  funding: 'platform' | 'merchant';
  /** Null = platform-wide. */
  merchantId: string | null;
  startsAt: Date;
  endsAt: Date;
  isActive: boolean;
  usageLimit: number | null;
  usedCount: number;
  perUserLimit: number;
  newUsersOnly: boolean;
}

export interface PricingInput {
  /** POS orders: no delivery, service or small-order fee; POS commission rate. */
  isPos?: boolean;
  now: Date;
  lines: readonly PricingLineInput[];
  merchant: {
    id: string;
    /** Null = platform default. */
    commissionBps: number | null;
    minOrderCentavos: Centavos;
    /** Merchant-funded free delivery. */
    freeDelivery: boolean;
  };
  /** Null for orders without delivery (POS). */
  delivery: {
    /** Merchant -> drop-off distance in metres. */
    distanceM: number;
    zone: ZoneFeeRules;
    /** From resolveSurgeBps; 10000 = no surge. */
    surgeBps: number;
  } | null;
  buyer: {
    /** Buyer is a verified merchant: wholesale tiers apply once min qty is met. */
    isWholesaleEligible: boolean;
    pointsBalance: number;
    walletBalanceCentavos: Centavos;
    /** Delivered orders so far (new-user vouchers). */
    completedOrderCount: number;
    /** Times this buyer already redeemed the voucher. */
    voucherUses: number;
  };
  voucher: VoucherInput | null;
  /** Points the buyer asks to redeem (capped by balance and pointsMaxRedeemBps). */
  usePoints: number;
  useWallet: boolean;
  tipCentavos: Centavos;
  roundUpDonation: boolean;
  settings: PricingSettings;
}

export type PricingIssueCode =
  | 'EMPTY_CART'
  | 'BELOW_MIN_ORDER'
  | 'VOUCHER_INACTIVE'
  | 'VOUCHER_NOT_STARTED'
  | 'VOUCHER_EXPIRED'
  | 'VOUCHER_WRONG_MERCHANT'
  | 'VOUCHER_USAGE_LIMIT'
  | 'VOUCHER_USER_LIMIT'
  | 'VOUCHER_NEW_USERS_ONLY'
  | 'VOUCHER_MIN_SPEND'
  | 'VOUCHER_NOT_APPLICABLE'
  | 'POINTS_CAPPED'
  | 'TIP_CAPPED';

export interface PricingIssue {
  code: PricingIssueCode;
  /** Blocking issues must stop checkout; others only adjust the quote. */
  blocking: boolean;
}

export interface PricedLine {
  key: string;
  /** Effective unit price incl. modifiers (and wholesale tier when used). */
  unitPriceCentavos: Centavos;
  lineTotalCentavos: Centavos;
  isWholesale: boolean;
}

export interface PriceQuote {
  lines: PricedLine[];
  isWholesale: boolean;
  subtotalCentavos: Centavos;
  /** Gross delivery fee after surge, before free-delivery discounts. */
  deliveryFeeCentavos: Centavos;
  surgeBps: number;
  serviceFeeCentavos: Centavos;
  smallOrderFeeCentavos: Centavos;
  itemDiscountCentavos: Centavos;
  deliveryDiscountCentavos: Centavos;
  /** itemDiscount + deliveryDiscount. */
  discountCentavos: Centavos;
  voucher: {
    id: string;
    code: string;
    discountCentavos: Centavos;
    funding: 'platform' | 'merchant';
  } | null;
  pointsRedeemed: number;
  pointsValueCentavos: Centavos;
  tipCentavos: Centavos;
  donationCentavos: Centavos;
  totalCentavos: Centavos;
  walletAppliedCentavos: Centavos;
  /** What the payment method must collect: total - wallet. */
  amountDueCentavos: Centavos;
  pointsEarnable: number;
  commissionBps: number;
  commissionCentavos: Centavos;
  /** May be negative (e.g. merchant-funded free delivery on a tiny order). */
  merchantNetCentavos: Centavos;
  riderEarningCentavos: Centavos;
  /** May be negative when platform-funded discounts exceed fees. */
  platformNetCentavos: Centavos;
  issues: PricingIssue[];
}

const NO_SURGE_BPS = 10_000;

/** Wholesale unit price: the tier with the highest minQty that the quantity meets. */
export function wholesaleUnitPrice(
  tiers: readonly WholesaleTier[] | undefined,
  quantity: number,
): Centavos | null {
  let best: WholesaleTier | null = null;
  for (const t of tiers ?? []) {
    if (quantity >= t.minQty && (!best || t.minQty > best.minQty)) best = t;
  }
  return best?.unitPriceCentavos ?? null;
}

export function priceLine(line: PricingLineInput, wholesaleEligible: boolean): PricedLine {
  const wholesale = wholesaleEligible
    ? wholesaleUnitPrice(line.wholesaleTiers, line.quantity)
    : null;
  const base = wholesale ?? line.unitPriceCentavos;
  const unit = Math.max(0, addCentavos(base, ...line.modifierDeltasCentavos));
  return {
    key: line.key,
    unitPriceCentavos: unit,
    lineTotalCentavos: multiplyCentavos(unit, line.quantity),
    isWholesale: wholesale !== null,
  };
}

const startedKm = (metres: number) => Math.ceil(Math.max(0, metres) / 1000);

/**
 * Zone tier for the distance band [min, max). Beyond the last tier: last tier fee + per-km fee per
 * started km past it. No matching tier: base fee covers the first km, then per started km.
 */
export function baseDeliveryFee(distanceM: number, zone: ZoneFeeRules): Centavos {
  const d = Math.max(0, Math.round(distanceM));
  const tiers = [...zone.tiers].sort((a, b) => a.minDistanceM - b.minDistanceM);
  const hit = tiers.find((t) => d >= t.minDistanceM && d < t.maxDistanceM);
  if (hit) return hit.feeCentavos;
  const last = tiers.at(-1);
  if (last && d >= last.maxDistanceM) {
    return addCentavos(
      last.feeCentavos,
      multiplyCentavos(zone.perKmFeeCentavos, startedKm(d - last.maxDistanceM)),
    );
  }
  return addCentavos(
    zone.baseDeliveryFeeCentavos,
    multiplyCentavos(zone.perKmFeeCentavos, startedKm(d - 1000)),
  );
}

export function deliveryFee(distanceM: number, zone: ZoneFeeRules, surgeBps: number): Centavos {
  return applyBasisPoints(baseDeliveryFee(distanceM, zone), Math.max(NO_SURGE_BPS, surgeBps));
}

export function serviceFee(subtotal: Centavos, s: PricingSettings): Centavos {
  if (subtotal <= 0 || s.serviceFeeBps === 0) return 0;
  const fee = applyBasisPoints(subtotal, s.serviceFeeBps);
  return Math.min(Math.max(fee, s.serviceFeeMinCentavos), s.serviceFeeMaxCentavos);
}

/** First failing eligibility rule, or null when the voucher can be used. */
export function voucherIneligibility(
  v: VoucherInput,
  input: Pick<PricingInput, 'now' | 'merchant' | 'buyer'>,
  subtotal: Centavos,
): PricingIssueCode | null {
  if (!v.isActive) return 'VOUCHER_INACTIVE';
  if (input.now < v.startsAt) return 'VOUCHER_NOT_STARTED';
  if (input.now >= v.endsAt) return 'VOUCHER_EXPIRED';
  if (v.merchantId !== null && v.merchantId !== input.merchant.id) return 'VOUCHER_WRONG_MERCHANT';
  if (v.usageLimit !== null && v.usedCount >= v.usageLimit) return 'VOUCHER_USAGE_LIMIT';
  if (input.buyer.voucherUses >= v.perUserLimit) return 'VOUCHER_USER_LIMIT';
  if (v.newUsersOnly && input.buyer.completedOrderCount > 0) return 'VOUCHER_NEW_USERS_ONLY';
  if (subtotal < v.minSpendCentavos) return 'VOUCHER_MIN_SPEND';
  return null;
}

const capAt = (amount: Centavos, cap: Centavos | null) =>
  cap === null ? amount : Math.min(amount, cap);

export function priceOrder(input: PricingInput): PriceQuote {
  const s = input.settings;
  const issues: PricingIssue[] = [];
  const issue = (code: PricingIssueCode, blocking = false) => issues.push({ code, blocking });

  // Lines
  const lines = input.lines.map((l) => priceLine(l, input.buyer.isWholesaleEligible));
  const subtotal = addCentavos(...lines.map((l) => l.lineTotalCentavos));
  if (lines.length === 0) issue('EMPTY_CART', true);
  else if (subtotal < input.merchant.minOrderCentavos) issue('BELOW_MIN_ORDER', true);

  // Fees
  const delivery = input.isPos ? null : input.delivery;
  const surgeBps = delivery
    ? Math.min(Math.max(NO_SURGE_BPS, delivery.surgeBps), s.maxSurgeBps)
    : NO_SURGE_BPS;
  const deliveryFeeGross = delivery ? deliveryFee(delivery.distanceM, delivery.zone, surgeBps) : 0;
  const service = input.isPos ? 0 : serviceFee(subtotal, s);
  const smallOrder =
    !input.isPos && subtotal > 0 && subtotal < s.smallOrderThresholdCentavos
      ? s.smallOrderFeeCentavos
      : 0;

  // Discounts, attributed to who funds them
  let merchantItemDisc = 0;
  let platformItemDisc = 0;
  const merchantDeliveryDisc = delivery && input.merchant.freeDelivery ? deliveryFeeGross : 0;
  let merchantDeliveryVoucher = 0;
  let platformDeliveryDisc = 0;
  let voucher: PriceQuote['voucher'] = null;

  const v = input.voucher;
  if (v) {
    const failed = voucherIneligibility(v, input, subtotal);
    let amount = 0;
    let onDelivery = false;
    if (!failed) {
      if (v.discountType === 'fixed') amount = Math.min(v.amountCentavos ?? 0, subtotal);
      else if (v.discountType === 'percent') {
        amount = capAt(applyBasisPoints(subtotal, v.percentBps ?? 0), v.maxDiscountCentavos);
      } else {
        onDelivery = true;
        amount = capAt(deliveryFeeGross - merchantDeliveryDisc, v.maxDiscountCentavos);
      }
    }
    if (failed) issue(failed);
    else if (amount <= 0) issue('VOUCHER_NOT_APPLICABLE');
    else {
      voucher = { id: v.id, code: v.code, discountCentavos: amount, funding: v.funding };
      const merchantFunded = v.funding === 'merchant';
      if (onDelivery) {
        if (merchantFunded) merchantDeliveryVoucher = amount;
        else platformDeliveryDisc = amount;
      } else if (merchantFunded) merchantItemDisc = amount;
      else platformItemDisc = amount;
    }
  }
  const merchantDeliveryTotal = merchantDeliveryDisc + merchantDeliveryVoucher;
  const itemDiscount = merchantItemDisc + platformItemDisc;
  const deliveryDiscount = merchantDeliveryTotal + platformDeliveryDisc;
  const itemsAfterDiscount = subtractCentavos(subtotal, itemDiscount);

  // Points (platform-funded)
  const requestedPoints = Math.max(0, Math.min(input.usePoints, input.buyer.pointsBalance));
  const maxPointsValue = applyBasisPoints(itemsAfterDiscount, s.pointsMaxRedeemBps);
  const pointsRedeemed = Math.min(
    requestedPoints,
    Math.floor(maxPointsValue / s.pointValueCentavos),
  );
  if (pointsRedeemed < input.usePoints) issue('POINTS_CAPPED');
  const pointsValue = multiplyCentavos(s.pointValueCentavos, pointsRedeemed);

  // Tip (delivery only), donation round-up, wallet
  let tip = delivery ? Math.max(0, input.tipCentavos) : 0;
  if (tip > s.maxTipCentavos) {
    tip = s.maxTipCentavos;
    issue('TIP_CAPPED');
  }
  const beforeDonation = subtractCentavos(
    addCentavos(subtotal, deliveryFeeGross, service, smallOrder, tip),
    addCentavos(itemDiscount, deliveryDiscount, pointsValue),
  );
  const step = s.donationRoundUpToCentavos;
  const remainder = beforeDonation % step;
  const donation =
    input.roundUpDonation && beforeDonation > 0 && remainder !== 0 ? step - remainder : 0;
  const total = addCentavos(beforeDonation, donation);
  const wallet = input.useWallet
    ? Math.max(0, Math.min(input.buyer.walletBalanceCentavos, total))
    : 0;

  // Splits
  const commissionBps = input.isPos
    ? s.posCommissionBps
    : (input.merchant.commissionBps ?? s.defaultCommissionBps);
  const commission = applyBasisPoints(subtractCentavos(subtotal, merchantItemDisc), commissionBps);
  const merchantNet = subtractCentavos(
    subtotal,
    addCentavos(merchantItemDisc, commission, merchantDeliveryTotal),
  );
  const riderDelivery = delivery
    ? Math.max(
        s.riderMinEarningCentavos,
        applyBasisPoints(deliveryFeeGross, s.riderDeliveryShareBps),
      )
    : 0;
  const platformNet = subtractCentavos(
    addCentavos(commission, service, smallOrder, deliveryFeeGross),
    addCentavos(riderDelivery, platformItemDisc, platformDeliveryDisc, pointsValue),
  );

  return {
    lines,
    isWholesale: lines.some((l) => l.isWholesale),
    subtotalCentavos: subtotal,
    deliveryFeeCentavos: deliveryFeeGross,
    surgeBps,
    serviceFeeCentavos: service,
    smallOrderFeeCentavos: smallOrder,
    itemDiscountCentavos: itemDiscount,
    deliveryDiscountCentavos: deliveryDiscount,
    discountCentavos: itemDiscount + deliveryDiscount,
    voucher,
    pointsRedeemed,
    pointsValueCentavos: pointsValue,
    tipCentavos: tip,
    donationCentavos: donation,
    totalCentavos: total,
    walletAppliedCentavos: wallet,
    amountDueCentavos: total - wallet,
    pointsEarnable: Math.floor(
      Math.max(0, itemsAfterDiscount - pointsValue) / s.pointsEarnPerCentavos,
    ),
    commissionBps,
    commissionCentavos: commission,
    merchantNetCentavos: merchantNet,
    riderEarningCentavos: riderDelivery + tip,
    platformNetCentavos: platformNet,
    issues,
  };
}

/**
 * Cancellation Protection: when a customer cancels after the merchant started preparing,
 * the merchant is compensated a share of the item subtotal.
 */
export function cancellationCompensation(
  subtotal: Centavos,
  preparingStarted: boolean,
  s: Pick<PricingSettings, 'cancellationProtectionBps'>,
): Centavos {
  return preparingStarted ? applyBasisPoints(subtotal, s.cancellationProtectionBps) : 0;
}

/** Customer-facing slice of a quote (no commission/net splits). */
export function toPriceBreakdown(q: PriceQuote): PriceBreakdown {
  return {
    subtotalCentavos: q.subtotalCentavos,
    deliveryFeeCentavos: q.deliveryFeeCentavos,
    serviceFeeCentavos: q.serviceFeeCentavos,
    smallOrderFeeCentavos: q.smallOrderFeeCentavos,
    discountCentavos: q.discountCentavos,
    deliveryDiscountCentavos: q.deliveryDiscountCentavos,
    pointsRedeemed: q.pointsRedeemed,
    pointsValueCentavos: q.pointsValueCentavos,
    tipCentavos: q.tipCentavos,
    donationCentavos: q.donationCentavos,
    totalCentavos: q.totalCentavos,
    walletAppliedCentavos: q.walletAppliedCentavos,
    amountDueCentavos: q.amountDueCentavos,
  };
}
