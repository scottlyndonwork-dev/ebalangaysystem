import { z } from 'zod';
import {
  paymentMethodSchema,
  paymentStatusSchema,
  pointsTransactionTypeSchema,
  voucherFundingSchema,
  walletTransactionTypeSchema,
} from '../enums.js';
import {
  basisPointsSchema,
  centavosSchema,
  cursorPageQuerySchema,
  idSchema,
  nonNegativeCentavosSchema,
  timestampSchema,
  urlSchema,
} from './common.js';

export const paymentSchema = z.object({
  id: idSchema,
  orderId: idSchema.nullable(),
  method: paymentMethodSchema,
  status: paymentStatusSchema,
  amountCentavos: nonNegativeCentavosSchema,
  refundedCentavos: nonNegativeCentavosSchema,
  provider: z.enum(['paymongo', 'internal']),
  providerReference: z.string().nullable(),
  /** Redirect for GCash/Maya/card 3DS. */
  checkoutUrl: urlSchema.nullable(),
  failureReason: z.string().nullable(),
  paidAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type Payment = z.infer<typeof paymentSchema>;

/** Send with an Idempotency-Key header. */
export const createPaymentInputSchema = z.object({
  orderId: idSchema,
  method: paymentMethodSchema,
  returnUrl: urlSchema.optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentInputSchema>;

export const walletSchema = z.object({
  id: idSchema,
  ownerId: idSchema,
  balanceCentavos: nonNegativeCentavosSchema,
  /** Funds held for in-flight payments or payouts. */
  heldCentavos: nonNegativeCentavosSchema,
  currency: z.literal('PHP'),
  updatedAt: timestampSchema,
});
export type Wallet = z.infer<typeof walletSchema>;

export const walletTransactionSchema = z.object({
  id: idSchema,
  walletId: idSchema,
  type: walletTransactionTypeSchema,
  /** Signed: credits positive, debits negative. */
  amountCentavos: centavosSchema,
  balanceAfterCentavos: nonNegativeCentavosSchema,
  orderId: idSchema.nullable(),
  reference: z.string().nullable(),
  description: z.string(),
  createdAt: timestampSchema,
});
export type WalletTransaction = z.infer<typeof walletTransactionSchema>;

export const topUpWalletInputSchema = z.object({
  amountCentavos: nonNegativeCentavosSchema.refine((v) => v >= 10_000, 'Minimum top-up is ₱100'),
  method: paymentMethodSchema.extract(['gcash', 'maya', 'card', 'bancnet']),
});
export type TopUpWalletInput = z.infer<typeof topUpWalletInputSchema>;

export const pointsBalanceSchema = z.object({
  balance: z.number().int().nonnegative(),
  expiringSoon: z.number().int().nonnegative(),
  expiringAt: timestampSchema.nullable(),
});
export type PointsBalance = z.infer<typeof pointsBalanceSchema>;

export const pointsTransactionSchema = z.object({
  id: idSchema,
  userId: idSchema,
  type: pointsTransactionTypeSchema,
  /** Signed: earn positive, redeem/expire negative. */
  points: z.number().int(),
  balanceAfter: z.number().int().nonnegative(),
  orderId: idSchema.nullable(),
  description: z.string(),
  expiresAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type PointsTransaction = z.infer<typeof pointsTransactionSchema>;

const voucherBase = z.object({
  id: idSchema,
  code: z.string().min(3).max(32),
  title: z.string().max(120),
  description: z.string().max(500).nullable(),
  funding: voucherFundingSchema,
  /** Null = platform-wide. */
  merchantId: idSchema.nullable(),
  minSpendCentavos: nonNegativeCentavosSchema,
  startsAt: timestampSchema,
  endsAt: timestampSchema,
  usageLimit: z.number().int().positive().nullable(),
  perUserLimit: z.number().int().positive(),
  usedCount: z.number().int().nonnegative(),
  isActive: z.boolean(),
});

export const voucherSchema = z.discriminatedUnion('discountType', [
  voucherBase.extend({
    discountType: z.literal('fixed'),
    amountCentavos: nonNegativeCentavosSchema,
  }),
  voucherBase.extend({
    discountType: z.literal('percent'),
    percentBps: basisPointsSchema.max(10_000),
    maxDiscountCentavos: nonNegativeCentavosSchema.nullable(),
  }),
  voucherBase.extend({
    discountType: z.literal('free_delivery'),
    maxDiscountCentavos: nonNegativeCentavosSchema.nullable(),
  }),
]);
export type Voucher = z.infer<typeof voucherSchema>;

export const listWalletTransactionsQuerySchema = cursorPageQuerySchema;
