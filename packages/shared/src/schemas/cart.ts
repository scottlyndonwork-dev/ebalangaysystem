import { z } from 'zod';
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
});
export type CartItem = z.infer<typeof cartItemSchema>;

/** Server-computed price breakdown, shared by cart quotes and orders. */
export const priceBreakdownSchema = z.object({
  subtotalCentavos: nonNegativeCentavosSchema,
  deliveryFeeCentavos: nonNegativeCentavosSchema,
  serviceFeeCentavos: nonNegativeCentavosSchema,
  smallOrderFeeCentavos: nonNegativeCentavosSchema,
  discountCentavos: nonNegativeCentavosSchema,
  tipCentavos: nonNegativeCentavosSchema,
  totalCentavos: nonNegativeCentavosSchema,
});
export type PriceBreakdown = z.infer<typeof priceBreakdownSchema>;

export const cartSchema = z.object({
  id: idSchema,
  merchantId: idSchema,
  items: z.array(cartItemSchema),
  voucherCode: z.string().nullable(),
  pricing: priceBreakdownSchema,
  /** Delivery-fee surge multiplier in basis points; 10000 = no surge. */
  surgeBps: z.number().int().min(10_000),
  pointsEarnable: z.number().int().nonnegative(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
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
  addressId: idSchema.optional(),
  tipCentavos: z.coerce.number().int().nonnegative().optional(),
});
export type CartQuoteQuery = z.infer<typeof cartQuoteQuerySchema>;

export const applyVoucherInputSchema = z.object({ code: z.string().trim().min(3).max(32) });
export type ApplyVoucherInput = z.infer<typeof applyVoucherInputSchema>;
