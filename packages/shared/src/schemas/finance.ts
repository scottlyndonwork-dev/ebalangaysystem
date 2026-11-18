import { z } from 'zod';
import { payoutStatusSchema, settlementStatusSchema } from '../enums.js';
import {
  centavosSchema,
  cursorPageQuerySchema,
  dateKeySchema,
  idSchema,
  nonNegativeCentavosSchema,
  timestampSchema,
} from './common.js';

export const payeeTypeSchema = z.enum(['merchant', 'rider']);
export type PayeeType = z.infer<typeof payeeTypeSchema>;

/** Period statement: what the platform owes a merchant or rider. */
export const settlementSchema = z.object({
  id: idSchema,
  payeeType: payeeTypeSchema,
  payeeId: idSchema,
  /** Manila calendar days, inclusive. */
  periodStart: dateKeySchema,
  periodEnd: dateKeySchema,
  orderCount: z.number().int().nonnegative(),
  grossCentavos: nonNegativeCentavosSchema,
  commissionCentavos: nonNegativeCentavosSchema,
  feesCentavos: nonNegativeCentavosSchema,
  /** COD cash the payee already collected and owes back. */
  cashCollectedCentavos: nonNegativeCentavosSchema,
  adjustmentsCentavos: centavosSchema,
  /** May be negative when COD collected exceeds earnings. */
  netPayableCentavos: centavosSchema,
  status: settlementStatusSchema,
  createdAt: timestampSchema,
});
export type Settlement = z.infer<typeof settlementSchema>;

export const payoutMethodSchema = z.enum(['gcash', 'maya', 'bank']);

export const payoutSchema = z.object({
  id: idSchema,
  payeeType: payeeTypeSchema,
  payeeId: idSchema,
  settlementId: idSchema.nullable(),
  amountCentavos: nonNegativeCentavosSchema,
  status: payoutStatusSchema,
  method: payoutMethodSchema,
  /** e.g. "GCash •••• 4567". Full account numbers never leave the server. */
  destinationLabel: z.string(),
  providerReference: z.string().nullable(),
  failureReason: z.string().nullable(),
  requestedAt: timestampSchema,
  paidAt: timestampSchema.nullable(),
});
export type Payout = z.infer<typeof payoutSchema>;

/** Send with an Idempotency-Key header. */
export const requestPayoutInputSchema = z.object({
  amountCentavos: nonNegativeCentavosSchema.refine((v) => v > 0, 'Amount must be positive'),
  payoutAccountId: idSchema,
});
export type RequestPayoutInput = z.infer<typeof requestPayoutInputSchema>;

export const listSettlementsQuerySchema = cursorPageQuerySchema.extend({
  payeeType: payeeTypeSchema.optional(),
  payeeId: idSchema.optional(),
  status: settlementStatusSchema.optional(),
});
