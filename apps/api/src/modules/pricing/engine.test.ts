import { describe, expect, it } from 'vitest';
import {
  baseDeliveryFee,
  cancellationCompensation,
  deliveryFee,
  priceOrder,
  type PricingInput,
  serviceFee,
  toPriceBreakdown,
  type VoucherInput,
  wholesaleUnitPrice,
  type ZoneFeeRules,
} from './engine.js';
import { DEFAULT_PRICING_SETTINGS as S } from './settings.js';

const NOW = new Date('2026-11-18T04:00:00Z');
const ZONE: ZoneFeeRules = {
  baseDeliveryFeeCentavos: 4_900,
  perKmFeeCentavos: 1_000,
  tiers: [
    { minDistanceM: 3_000, maxDistanceM: 6_000, feeCentavos: 6_900 },
    { minDistanceM: 0, maxDistanceM: 3_000, feeCentavos: 4_900 },
    { minDistanceM: 6_000, maxDistanceM: 10_000, feeCentavos: 9_900 },
  ],
};

const voucher = (over: Partial<VoucherInput> = {}): VoucherInput => ({
  id: 'v1',
  code: 'SAVE',
  discountType: 'fixed',
  amountCentavos: 5_000,
  percentBps: null,
  maxDiscountCentavos: null,
  minSpendCentavos: 0,
  funding: 'platform',
  merchantId: null,
  startsAt: new Date('2026-01-01T00:00:00Z'),
  endsAt: new Date('2027-01-01T00:00:00Z'),
  isActive: true,
  usageLimit: null,
  usedCount: 0,
  perUserLimit: 1,
  newUsersOnly: false,
  ...over,
});

function input(over: Partial<PricingInput> = {}): PricingInput {
  return {
    now: NOW,
    lines: [
      { key: 'a', unitPriceCentavos: 15_000, modifierDeltasCentavos: [2_000], quantity: 2 },
      { key: 'b', unitPriceCentavos: 6_000, modifierDeltasCentavos: [], quantity: 1 },
    ],
    merchant: { id: 'm1', commissionBps: null, minOrderCentavos: 0, freeDelivery: false },
    delivery: { distanceM: 2_000, zone: ZONE, surgeBps: 10_000 },
    buyer: {
      isWholesaleEligible: false,
      pointsBalance: 0,
      walletBalanceCentavos: 0,
      completedOrderCount: 3,
      voucherUses: 0,
    },
    voucher: null,
    usePoints: 0,
    useWallet: false,
    tipCentavos: 0,
    roundUpDonation: false,
    settings: S,
    ...over,
  };
}

const codes = (q: ReturnType<typeof priceOrder>) => q.issues.map((i) => i.code);

function expectIdentity(q: ReturnType<typeof priceOrder>) {
  expect(
    q.merchantNetCentavos + q.riderEarningCentavos + q.platformNetCentavos + q.donationCentavos,
  ).toBe(q.totalCentavos);
  expect(
    q.subtotalCentavos +
      q.deliveryFeeCentavos +
      q.serviceFeeCentavos +
      q.smallOrderFeeCentavos +
      q.tipCentavos +
      q.donationCentavos -
      q.discountCentavos -
      q.pointsValueCentavos,
  ).toBe(q.totalCentavos);
  expect(q.totalCentavos).toBeGreaterThanOrEqual(0);
  expect(q.amountDueCentavos).toBe(q.totalCentavos - q.walletAppliedCentavos);
  expect(q.amountDueCentavos).toBeGreaterThanOrEqual(0);
  for (const v of Object.values(q))
    if (typeof v === 'number') expect(Number.isSafeInteger(v)).toBe(true);
}

describe('lines', () => {
  it('prices unit + modifiers x qty and sums the subtotal', () => {
    const q = priceOrder(input());
    expect(q.lines.map((l) => [l.unitPriceCentavos, l.lineTotalCentavos])).toEqual([
      [17_000, 34_000],
      [6_000, 6_000],
    ]);
    expect(q.subtotalCentavos).toBe(40_000);
  });

  it('negative modifier deltas never push a unit below zero', () => {
    const q = priceOrder(
      input({
        lines: [
          { key: 'a', unitPriceCentavos: 1_000, modifierDeltasCentavos: [-5_000], quantity: 3 },
        ],
      }),
    );
    expect(q.lines[0]).toMatchObject({ unitPriceCentavos: 0, lineTotalCentavos: 0 });
  });

  it('wholesale tier: highest min qty met, only for eligible buyers', () => {
    const tiers = [
      { minQty: 10, unitPriceCentavos: 900 },
      { minQty: 50, unitPriceCentavos: 800 },
    ];
    expect(wholesaleUnitPrice(tiers, 9)).toBeNull();
    expect(wholesaleUnitPrice(tiers, 10)).toBe(900);
    expect(wholesaleUnitPrice(tiers, 75)).toBe(800);
    const line = {
      key: 'w',
      unitPriceCentavos: 1_000,
      modifierDeltasCentavos: [],
      quantity: 50,
      wholesaleTiers: tiers,
    };
    const retail = priceOrder(input({ lines: [line] }));
    expect(retail.isWholesale).toBe(false);
    expect(retail.subtotalCentavos).toBe(50_000);
    const buyer = { ...input().buyer, isWholesaleEligible: true };
    const ws = priceOrder(input({ lines: [line], buyer }));
    expect(ws.isWholesale).toBe(true);
    expect(ws.subtotalCentavos).toBe(40_000);
    const below = priceOrder(input({ lines: [{ ...line, quantity: 5 }], buyer }));
    expect(below.isWholesale).toBe(false);
  });

  it('flags empty carts and orders below the store minimum as blocking', () => {
    expect(priceOrder(input({ lines: [] })).issues).toEqual([
      { code: 'EMPTY_CART', blocking: true },
    ]);
    const m = { ...input().merchant, minOrderCentavos: 50_000 };
    expect(priceOrder(input({ merchant: m })).issues).toEqual([
      { code: 'BELOW_MIN_ORDER', blocking: true },
    ]);
  });
});

describe('delivery fee', () => {
  it('uses the zone tier band [min, max)', () => {
    expect(baseDeliveryFee(0, ZONE)).toBe(4_900);
    expect(baseDeliveryFee(2_999, ZONE)).toBe(4_900);
    expect(baseDeliveryFee(3_000, ZONE)).toBe(6_900);
    expect(baseDeliveryFee(9_999, ZONE)).toBe(9_900);
  });

  it('adds per-km per started km past the last tier', () => {
    expect(baseDeliveryFee(10_000, ZONE)).toBe(9_900);
    expect(baseDeliveryFee(10_001, ZONE)).toBe(10_900);
    expect(baseDeliveryFee(12_500, ZONE)).toBe(12_900);
  });

  it('without tiers: base covers the first km, then per started km', () => {
    const z = { ...ZONE, tiers: [] };
    expect(baseDeliveryFee(800, z)).toBe(4_900);
    expect(baseDeliveryFee(1_000, z)).toBe(4_900);
    expect(baseDeliveryFee(1_001, z)).toBe(5_900);
    expect(baseDeliveryFee(3_200, z)).toBe(7_900);
  });

  it('applies surge (half-up) and ignores multipliers below 1x', () => {
    expect(deliveryFee(2_000, ZONE, 15_000)).toBe(7_350);
    expect(deliveryFee(2_000, ZONE, 12_345)).toBe(6_049);
    expect(deliveryFee(2_000, ZONE, 5_000)).toBe(4_900);
  });

  it('caps surge at maxSurgeBps', () => {
    const q = priceOrder(input({ delivery: { distanceM: 2_000, zone: ZONE, surgeBps: 40_000 } }));
    expect(q.surgeBps).toBe(S.maxSurgeBps);
    expect(q.deliveryFeeCentavos).toBe(9_800);
  });

  it('merchant free delivery waives the fee as a merchant-funded discount', () => {
    const q = priceOrder(input({ merchant: { ...input().merchant, freeDelivery: true } }));
    expect(q.deliveryFeeCentavos).toBe(4_900);
    expect(q.deliveryDiscountCentavos).toBe(4_900);
    expect(q.merchantNetCentavos).toBe(40_000 - 4_000 - 4_900);
    expect(q.riderEarningCentavos).toBe(4_000);
    expectIdentity(q);
  });
});

describe('service and small-order fees', () => {
  it('service fee = bps of subtotal clamped to [min, max]', () => {
    expect(serviceFee(0, S)).toBe(0);
    expect(serviceFee(10_000, S)).toBe(500);
    expect(serviceFee(40_000, S)).toBe(800);
    expect(serviceFee(1_000_000, S)).toBe(2_500);
    expect(serviceFee(40_000, { ...S, serviceFeeBps: 0 })).toBe(0);
  });

  it('small-order fee below the threshold only', () => {
    const small = (p: number) =>
      priceOrder(
        input({
          lines: [{ key: 'a', unitPriceCentavos: p, modifierDeltasCentavos: [], quantity: 1 }],
        }),
      );
    expect(small(9_999).smallOrderFeeCentavos).toBe(1_500);
    expect(small(10_000).smallOrderFeeCentavos).toBe(0);
  });

  it('POS orders: no delivery, service or small-order fee; POS commission', () => {
    const q = priceOrder(
      input({
        isPos: true,
        tipCentavos: 2_000,
        lines: [{ key: 'a', unitPriceCentavos: 5_000, modifierDeltasCentavos: [], quantity: 1 }],
      }),
    );
    expect(q).toMatchObject({
      deliveryFeeCentavos: 0,
      serviceFeeCentavos: 0,
      smallOrderFeeCentavos: 0,
      tipCentavos: 0,
      totalCentavos: 5_000,
      commissionCentavos: 0,
      merchantNetCentavos: 5_000,
      riderEarningCentavos: 0,
      platformNetCentavos: 0,
    });
  });
});

describe('vouchers', () => {
  it('fixed: capped at the subtotal', () => {
    const q = priceOrder(input({ voucher: voucher({ amountCentavos: 100_000 }) }));
    expect(q.itemDiscountCentavos).toBe(40_000);
    expect(q.voucher?.discountCentavos).toBe(40_000);
    expectIdentity(q);
  });

  it('percent: bps of subtotal, capped by max discount', () => {
    const pct = voucher({ discountType: 'percent', amountCentavos: null, percentBps: 2_000 });
    expect(priceOrder(input({ voucher: pct })).itemDiscountCentavos).toBe(8_000);
    expect(
      priceOrder(input({ voucher: { ...pct, maxDiscountCentavos: 5_000 } })).itemDiscountCentavos,
    ).toBe(5_000);
  });

  it('free delivery: discounts the surged fee, capped by max discount', () => {
    const fd = voucher({ discountType: 'free_delivery', amountCentavos: null });
    const q = priceOrder(
      input({ voucher: fd, delivery: { distanceM: 4_000, zone: ZONE, surgeBps: 15_000 } }),
    );
    expect(q.deliveryFeeCentavos).toBe(10_350);
    expect(q.deliveryDiscountCentavos).toBe(10_350);
    expect(q.itemDiscountCentavos).toBe(0);
    const capped = priceOrder(input({ voucher: { ...fd, maxDiscountCentavos: 3_000 } }));
    expect(capped.deliveryDiscountCentavos).toBe(3_000);
  });

  it('free delivery is not applicable when the store already delivers free or for POS', () => {
    const fd = voucher({ discountType: 'free_delivery', amountCentavos: null });
    const free = priceOrder(
      input({ voucher: fd, merchant: { ...input().merchant, freeDelivery: true } }),
    );
    expect(free.voucher).toBeNull();
    expect(codes(free)).toEqual(['VOUCHER_NOT_APPLICABLE']);
    expect(codes(priceOrder(input({ voucher: fd, isPos: true })))).toEqual([
      'VOUCHER_NOT_APPLICABLE',
    ]);
  });

  it('merchant-funded discounts reduce merchant net and commission base; platform-funded do not', () => {
    const base = priceOrder(input());
    const plat = priceOrder(input({ voucher: voucher() }));
    const merch = priceOrder(
      input({ voucher: voucher({ funding: 'merchant', merchantId: 'm1' }) }),
    );
    expect(plat.merchantNetCentavos).toBe(base.merchantNetCentavos);
    expect(plat.platformNetCentavos).toBe(base.platformNetCentavos - 5_000);
    expect(merch.commissionCentavos).toBe(3_500);
    expect(merch.merchantNetCentavos).toBe(40_000 - 5_000 - 3_500);
    expectIdentity(plat);
    expectIdentity(merch);
  });

  it.each([
    [{ isActive: false }, {}, 'VOUCHER_INACTIVE'],
    [{ startsAt: new Date('2026-12-01T00:00:00Z') }, {}, 'VOUCHER_NOT_STARTED'],
    [{ endsAt: NOW }, {}, 'VOUCHER_EXPIRED'],
    [{ merchantId: 'other' }, {}, 'VOUCHER_WRONG_MERCHANT'],
    [{ usageLimit: 10, usedCount: 10 }, {}, 'VOUCHER_USAGE_LIMIT'],
    [{ perUserLimit: 1 }, { voucherUses: 1 }, 'VOUCHER_USER_LIMIT'],
    [{ newUsersOnly: true }, { completedOrderCount: 1 }, 'VOUCHER_NEW_USERS_ONLY'],
    [{ minSpendCentavos: 40_001 }, {}, 'VOUCHER_MIN_SPEND'],
  ] as const)('rejects %o -> %s (non-blocking, not applied)', (v, buyer, code) => {
    const q = priceOrder(input({ voucher: voucher(v), buyer: { ...input().buyer, ...buyer } }));
    expect(q.issues).toEqual([{ code, blocking: false }]);
    expect(q.voucher).toBeNull();
    expect(q.discountCentavos).toBe(0);
  });

  it('accepts min spend exactly met and new users with no orders', () => {
    const q = priceOrder(
      input({
        voucher: voucher({ minSpendCentavos: 40_000, newUsersOnly: true }),
        buyer: { ...input().buyer, completedOrderCount: 0 },
      }),
    );
    expect(q.issues).toEqual([]);
    expect(q.discountCentavos).toBe(5_000);
  });
});

describe('points, tip, donation, wallet', () => {
  it('redeems points up to balance and max redeem share', () => {
    const buyer = { ...input().buyer, pointsBalance: 1_000 };
    const ok = priceOrder(input({ buyer, usePoints: 100 }));
    expect(ok).toMatchObject({ pointsRedeemed: 100, pointsValueCentavos: 10_000, issues: [] });
    // 50% of 40,000 = 20,000 centavos = 200 points max
    const capped = priceOrder(input({ buyer, usePoints: 500 }));
    expect(capped.pointsRedeemed).toBe(200);
    expect(codes(capped)).toEqual(['POINTS_CAPPED']);
    const poor = priceOrder(input({ buyer: { ...buyer, pointsBalance: 30 }, usePoints: 100 }));
    expect(poor.pointsRedeemed).toBe(30);
    expectIdentity(capped);
  });

  it('points cap is computed after item discounts', () => {
    const buyer = { ...input().buyer, pointsBalance: 1_000 };
    const q = priceOrder(
      input({ buyer, usePoints: 500, voucher: voucher({ amountCentavos: 20_000 }) }),
    );
    expect(q.pointsRedeemed).toBe(100);
  });

  it('earns points on the item amount actually paid', () => {
    expect(priceOrder(input()).pointsEarnable).toBe(4);
    const buyer = { ...input().buyer, pointsBalance: 1_000 };
    expect(priceOrder(input({ buyer, usePoints: 200 })).pointsEarnable).toBe(2);
  });

  it('tip goes 100% to the rider and is capped', () => {
    const q = priceOrder(input({ tipCentavos: 2_000 }));
    expect(q.riderEarningCentavos).toBe(4_000 + 2_000);
    const capped = priceOrder(input({ tipCentavos: 500_000 }));
    expect(capped.tipCentavos).toBe(S.maxTipCentavos);
    expect(codes(capped)).toEqual(['TIP_CAPPED']);
  });

  it('rider earns share of the surged fee, with a floor', () => {
    expect(priceOrder(input()).riderEarningCentavos).toBe(4_000);
    const far = priceOrder(input({ delivery: { distanceM: 7_000, zone: ZONE, surgeBps: 15_000 } }));
    expect(far.riderEarningCentavos).toBe(11_880);
  });

  it('donation rounds the total up to the next step; 0 when already round', () => {
    const base = priceOrder(input());
    expect(base.totalCentavos).toBe(40_000 + 4_900 + 800);
    const q = priceOrder(input({ roundUpDonation: true }));
    expect(q.donationCentavos).toBe(300);
    expect(q.totalCentavos).toBe(46_000);
    const round = priceOrder(input({ roundUpDonation: true, tipCentavos: 300 }));
    expect(round.donationCentavos).toBe(0);
  });

  it('wallet covers up to the total; the rest is amount due', () => {
    const rich = priceOrder(
      input({ useWallet: true, buyer: { ...input().buyer, walletBalanceCentavos: 1_000_000 } }),
    );
    expect(rich.walletAppliedCentavos).toBe(rich.totalCentavos);
    expect(rich.amountDueCentavos).toBe(0);
    const some = priceOrder(
      input({ useWallet: true, buyer: { ...input().buyer, walletBalanceCentavos: 10_000 } }),
    );
    expect(some.amountDueCentavos).toBe(some.totalCentavos - 10_000);
    const off = priceOrder(
      input({ useWallet: false, buyer: { ...input().buyer, walletBalanceCentavos: 10_000 } }),
    );
    expect(off.walletAppliedCentavos).toBe(0);
  });
});

describe('commission and splits', () => {
  it('uses merchant commission override, else the platform default', () => {
    expect(priceOrder(input()).commissionCentavos).toBe(4_000);
    const q = priceOrder(input({ merchant: { ...input().merchant, commissionBps: 1_250 } }));
    expect(q.commissionBps).toBe(1_250);
    expect(q.commissionCentavos).toBe(5_000);
    expect(q.merchantNetCentavos).toBe(35_000);
  });

  it('full example breakdown', () => {
    const q = priceOrder(input());
    expect(q).toMatchObject({
      subtotalCentavos: 40_000,
      deliveryFeeCentavos: 4_900,
      serviceFeeCentavos: 800,
      smallOrderFeeCentavos: 0,
      totalCentavos: 45_700,
      commissionCentavos: 4_000,
      merchantNetCentavos: 36_000,
      riderEarningCentavos: 4_000,
      platformNetCentavos: 4_000 + 800 + 900,
    });
    expectIdentity(q);
    expect(toPriceBreakdown(q)).toMatchObject({ totalCentavos: 45_700, amountDueCentavos: 45_700 });
  });
});

describe('every fee/discount combination', () => {
  const vouchers: (VoucherInput | null)[] = [
    null,
    voucher(),
    voucher({ funding: 'merchant' }),
    voucher({
      discountType: 'percent',
      amountCentavos: null,
      percentBps: 1_500,
      maxDiscountCentavos: 4_000,
    }),
    voucher({
      discountType: 'percent',
      amountCentavos: null,
      percentBps: 10_000,
      funding: 'merchant',
    }),
    voucher({ discountType: 'free_delivery', amountCentavos: null }),
    voucher({ discountType: 'free_delivery', amountCentavos: null, funding: 'merchant' }),
    voucher({ minSpendCentavos: 10_000_000 }),
  ];
  const subtotals = [0, 5_000, 40_000, 300_000];
  const combos: [string, PricingInput][] = [];
  for (const v of vouchers)
    for (const price of subtotals)
      for (const isPos of [false, true])
        for (const freeDelivery of [false, true])
          for (const surgeBps of [10_000, 17_500])
            for (const distanceM of [500, 4_200, 15_000])
              for (const [usePoints, useWallet, tip, roundUp] of [
                [0, false, 0, false],
                [9_999, true, 2_500, true],
                [50, false, 0, true],
              ] as const)
                combos.push([
                  `${v?.discountType ?? 'none'}/${v?.funding ?? '-'} sub=${price} pos=${isPos} free=${freeDelivery} surge=${surgeBps} d=${distanceM} pts=${usePoints}`,
                  input({
                    isPos,
                    voucher: v,
                    lines: price
                      ? [
                          {
                            key: 'a',
                            unitPriceCentavos: price,
                            modifierDeltasCentavos: [],
                            quantity: 1,
                          },
                        ]
                      : [],
                    merchant: { ...input().merchant, freeDelivery },
                    delivery: { distanceM, zone: ZONE, surgeBps },
                    buyer: {
                      ...input().buyer,
                      pointsBalance: 5_000,
                      walletBalanceCentavos: 20_000,
                    },
                    usePoints,
                    useWallet,
                    tipCentavos: tip,
                    roundUpDonation: roundUp,
                  }),
                ]);

  it(`holds the money identity for ${combos.length} combinations`, () => {
    for (const [name, inp] of combos) {
      const q = priceOrder(inp);
      try {
        expectIdentity(q);
        expect(q.discountCentavos).toBeLessThanOrEqual(q.subtotalCentavos + q.deliveryFeeCentavos);
        expect(q.deliveryDiscountCentavos).toBeLessThanOrEqual(q.deliveryFeeCentavos);
        expect(q.pointsValueCentavos).toBeLessThanOrEqual(
          q.subtotalCentavos - q.itemDiscountCentavos,
        );
        if (inp.isPos)
          expect(q.deliveryFeeCentavos + q.serviceFeeCentavos + q.riderEarningCentavos).toBe(0);
      } catch (e) {
        throw new Error(`${name}: ${(e as Error).message}`, { cause: e });
      }
    }
  });
});

describe('cancellation protection', () => {
  it('compensates 50% of the item subtotal only after preparing started', () => {
    expect(cancellationCompensation(40_001, true, S)).toBe(20_001);
    expect(cancellationCompensation(40_000, false, S)).toBe(0);
    expect(cancellationCompensation(40_000, true, { cancellationProtectionBps: 2_500 })).toBe(
      10_000,
    );
  });
});
