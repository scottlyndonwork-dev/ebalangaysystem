import { z } from 'zod';
import { type ValueOf, zEnum } from '../enums.js';
import { idSchema, nonNegativeCentavosSchema, timestampSchema } from './common.js';

/** What the client sends: selections only, never prices. */
export const cartItemSelectionSchema = z.object({
  productId: idSchema,
  variantId: idSchema.nullable().default(null),
  quantity: z.number().int().min(1).max(999),
  modifierOptionIds: z.array(idSchema).max(50).default([]),
  notes: z.string().trim().max(200).nullable().default(null),
});
export type CartItemSelection = z.input<typeof cartItemSelectionSchema>;

export const cartItemSchema = cartItemSelectionSchema.extend({
  id: idSchema,
  name: z.string(),
  variantName: z.string().nullable(),
  imageUrl: z.string().nullable(),
  modifierNames: z.array(z.string()),
  unitPriceCentavos: nonNegativeCentavosSchema,
  lineTotalCentavos: nonNegativeCentavosSchema,
  /** False when the item became unavailable since it was added. */
  isAvailable: z.boolean(),
  /** Group carts: the member who added the item. */
  memberId: idSchema.nullable(),
});
export type CartItem = z.infer<typeof cartItemSchema>;

/** Server-computed price breakdown, shared by cart quotes and orders. */
export const priceBreakdownSchema = z.object({
  subtotalCentavos: nonNegativeCentavosSchema,
  /** Gross delivery fee after surge; free delivery shows up in deliveryDiscountCentavos. */
  deliveryFeeCentavos: nonNegativeCentavosSchema,
  serviceFeeCentavos: nonNegativeCentavosSchema,
  smallOrderFeeCentavos: nonNegativeCentavosSchema,
  /** All discounts: item discounts + deliveryDiscountCentavos. */
  discountCentavos: nonNegativeCentavosSchema,
  deliveryDiscountCentavos: nonNegativeCentavosSchema,
  pointsRedeemed: z.number().int().nonnegative(),
  pointsValueCentavos: nonNegativeCentavosSchema,
  tipCentavos: nonNegativeCentavosSchema,
  donationCentavos: nonNegativeCentavosSchema,
  totalCentavos: nonNegativeCentavosSchema,
  walletAppliedCentavos: nonNegativeCentavosSchema,
  /** Charged to the payment method: total - wallet. */
  amountDueCentavos: nonNegativeCentavosSchema,
});
export type PriceBreakdown = z.infer<typeof priceBreakdownSchema>;

export const cartWarningSchema = z.object({ code: z.string(), message: z.string() });
export type CartWarning = z.infer<typeof cartWarningSchema>;

export const cartSchema = z.object({
  id: idSchema,
  merchantId: idSchema,
  /** Set when this cart backs a group order. */
  groupCartId: idSchema.nullable(),
  items: z.array(cartItemSchema),
  voucherCode: z.string().nullable(),
  pricing: priceBreakdownSchema,
  /** Delivery-fee surge multiplier in basis points; 10000 = no surge. */
  surgeBps: z.number().int().min(10_000),
  pointsEarnable: z.number().int().nonnegative(),
  warnings: z.array(cartWarningSchema),
  updatedAt: timestampSchema,
});
export type Cart = z.infer<typeof cartSchema>;

export const addCartItemInputSchema = cartItemSelectionSchema.extend({ merchantId: idSchema });
export type AddCartItemInput = z.input<typeof addCartItemInputSchema>;

export const updateCartItemInputSchema = z
  .object({
    quantity: z.number().int().min(1).max(999),
    modifierOptionIds: z.array(idSchema).max(50),
    notes: z.string().trim().max(200).nullable(),
  })
  .partial();
export type UpdateCartItemInput = z.infer<typeof updateCartItemInputSchema>;

export const cartQuoteQuerySchema = z.object({
  /** Defaults to the caller's default address. */
  addressId: idSchema.optional(),
  tipCentavos: z.coerce.number().int().nonnegative().optional(),
  usePoints: z.coerce.number().int().nonnegative().optional(),
  roundUpDonation: z.stringbool().optional(),
  /** Scheduled checkout: store hours are checked at this time instead of now. */
  scheduledFor: timestampSchema.optional(),
});
export type CartQuoteQuery = z.infer<typeof cartQuoteQuerySchema>;

export const applyVoucherInputSchema = z.object({ code: z.string().trim().min(3).max(32) });
export type ApplyVoucherInput = z.infer<typeof applyVoucherInputSchema>;

export const pricingIssueSchema = z.object({
  code: z.string(),
  /** Blocking issues stop checkout; the rest only adjust the quote. */
  blocking: z.boolean(),
});
export type PricingIssue = z.infer<typeof pricingIssueSchema>;

export const memberShareSchema = z.object({
  memberId: idSchema,
  userId: idSchema,
  displayName: z.string(),
  subtotalCentavos: nonNegativeCentavosSchema,
  /** Own items plus a pro-rata share of fees and discounts. Shares sum to the total. */
  amountDueCentavos: nonNegativeCentavosSchema,
});
export type MemberShare = z.infer<typeof memberShareSchema>;

/** Full checkout preview: what placing the order would charge right now. */
export const checkoutQuoteSchema = z.object({
  cart: cartSchema,
  addressId: idSchema.nullable(),
  distanceMeters: z.number().int().nonnegative().nullable(),
  etaMinutes: z.number().int().positive().nullable(),
  etaAt: timestampSchema.nullable(),
  isWholesale: z.boolean(),
  canCheckout: z.boolean(),
  issues: z.array(pricingIssueSchema),
  /** Group carts only; empty otherwise. */
  memberShares: z.array(memberShareSchema),
});
export type CheckoutQuote = z.infer<typeof checkoutQuoteSchema>;

// ------------------------------------------------------------------ group carts

export const GroupCartStatus = {
  OPEN: 'open',
  LOCKED: 'locked',
  ORDERED: 'ordered',
  CANCELLED: 'cancelled',
} as const;
export type GroupCartStatus = ValueOf<typeof GroupCartStatus>;
export const groupCartStatusSchema = zEnum(GroupCartStatus);

const displayNameSchema = z.string().trim().min(1).max(60);

/** The host's cart for this store becomes the group cart (one cart per user per store). */
export const createGroupCartInputSchema = z.object({
  merchantId: idSchema,
  displayName: displayNameSchema,
  deadlineAt: timestampSchema.nullable().default(null),
});
export type CreateGroupCartInput = z.input<typeof createGroupCartInputSchema>;

export const joinGroupCartInputSchema = z.object({
  code: z.string().trim().toUpperCase().min(6).max(16),
  displayName: displayNameSchema,
});
export type JoinGroupCartInput = z.input<typeof joinGroupCartInputSchema>;

export const setMemberReadyInputSchema = z.object({ isReady: z.boolean() });
export type SetMemberReadyInput = z.infer<typeof setMemberReadyInputSchema>;

export const groupCartMemberSchema = z.object({
  id: idSchema,
  userId: idSchema,
  displayName: z.string(),
  isHost: z.boolean(),
  isReady: z.boolean(),
  itemCount: z.number().int().nonnegative(),
  subtotalCentavos: nonNegativeCentavosSchema,
  /** Set by the latest host checkout quote. */
  amountDueCentavos: nonNegativeCentavosSchema.nullable(),
});
export type GroupCartMember = z.infer<typeof groupCartMemberSchema>;

export const groupCartSchema = z.object({
  id: idSchema,
  /** Invite code; the invite link is built from it by the apps. */
  code: z.string(),
  merchantId: idSchema,
  hostUserId: idSchema,
  status: groupCartStatusSchema,
  deadlineAt: timestampSchema.nullable(),
  /** Every member's items; only the host checks out. */
  cart: cartSchema,
  members: z.array(groupCartMemberSchema),
  createdAt: timestampSchema,
});
export type GroupCart = z.infer<typeof groupCartSchema>;
