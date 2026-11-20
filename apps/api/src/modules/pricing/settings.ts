import { z } from 'zod';
import type { Db, Tx } from '../../db.js';
import { loadSettings } from '../../lib/settings.js';

const bps = z.number().int().min(0).max(10_000);
const centavos = z.number().int().nonnegative();

/**
 * Admin-tunable pricing knobs. Each field is one `platform_settings` row (key = snake_case of
 * the field name, value = JSON number); missing or invalid rows fall back to the default.
 */
export const pricingSettingsSchema = z.object({
  /** Platform commission when merchants.commission_bps is null. */
  defaultCommissionBps: bps,
  /** Commission on in-store POS sales. */
  posCommissionBps: bps,
  serviceFeeBps: bps,
  serviceFeeMinCentavos: centavos,
  serviceFeeMaxCentavos: centavos,
  /** Small-order fee applies when the item subtotal is below the threshold. */
  smallOrderThresholdCentavos: centavos,
  smallOrderFeeCentavos: centavos,
  /** Hard cap on any surge multiplier (10000 = none). */
  maxSurgeBps: z.number().int().min(10_000).max(50_000),
  /** Rider's share of the (surged) delivery fee; tips always go 100% to the rider. */
  riderDeliveryShareBps: bps,
  riderMinEarningCentavos: centavos,
  maxTipCentavos: centavos,
  /** Value of one loyalty point. */
  pointValueCentavos: z.number().int().positive(),
  /** One point earned per this much (subtotal after item discounts). */
  pointsEarnPerCentavos: z.number().int().positive(),
  /** Points may pay at most this share of (subtotal after item discounts). */
  pointsMaxRedeemBps: bps,
  /** Donation round-up rounds the total up to the next multiple of this. */
  donationRoundUpToCentavos: z.number().int().positive(),
  /** Cancellation Protection: merchant compensation as a share of the item subtotal. */
  cancellationProtectionBps: bps,
});
export type PricingSettings = z.infer<typeof pricingSettingsSchema>;

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  defaultCommissionBps: 1_000,
  posCommissionBps: 0,
  serviceFeeBps: 200,
  serviceFeeMinCentavos: 500,
  serviceFeeMaxCentavos: 2_500,
  smallOrderThresholdCentavos: 10_000,
  smallOrderFeeCentavos: 1_500,
  maxSurgeBps: 20_000,
  riderDeliveryShareBps: 8_000,
  riderMinEarningCentavos: 4_000,
  maxTipCentavos: 100_000,
  pointValueCentavos: 100,
  pointsEarnPerCentavos: 10_000,
  pointsMaxRedeemBps: 5_000,
  donationRoundUpToCentavos: 1_000,
  cancellationProtectionBps: 5_000,
};

export async function loadPricingSettings(db: Db | Tx): Promise<PricingSettings> {
  return loadSettings(db, pricingSettingsSchema, DEFAULT_PRICING_SETTINGS);
}
