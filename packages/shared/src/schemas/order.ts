import { z } from 'zod';
import {
  type ValueOf,
  zEnum,
  orderStatusSchema,
  orderTypeSchema,
  paymentMethodSchema,
  paymentStatusSchema,
  prepUpdateSchema,
  userRoleSchema,
} from '../enums.js';
import { orderActorSchema } from '../order-state-machine.js';
import { addressSnapshotSchema } from './address.js';
import { priceBreakdownSchema } from './cart.js';
import {
  centavosSchema,
  cursorPageQuerySchema,
  idSchema,
  nonNegativeCentavosSchema,
  phPhoneSchema,
  timestampSchema,
} from './common.js';

export const orderItemSchema = z.object({
  id: idSchema,
  productId: idSchema,
  variantId: idSchema.nullable(),
  name: z.string(),
  variantName: z.string().nullable(),
  quantity: z.number().int().min(1),
  unitPriceCentavos: nonNegativeCentavosSchema,
  modifiers: z.array(z.object({ name: z.string(), priceDeltaCentavos: centavosSchema })),
  lineTotalCentavos: nonNegativeCentavosSchema,
  notes: z.string().nullable(),
  /** Set when the customer rejected a replacement for this item; excluded from totals. */
  removedAt: timestampSchema.nullable(),
});
export type OrderItem = z.infer<typeof orderItemSchema>;

export const giftDetailsSchema = z.object({
  recipientName: z.string().trim().min(1).max(120),
  recipientPhone: phPhoneSchema,
  message: z.string().trim().max(300).nullable(),
  hidePrices: z.boolean(),
});
export type GiftDetails = z.infer<typeof giftDetailsSchema>;

export const ReplacementStatus = {
  PROPOSED: 'proposed',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
} as const;
export type ReplacementStatus = ValueOf<typeof ReplacementStatus>;
export const replacementStatusSchema = zEnum(ReplacementStatus);

/** Merchant's substitute for an out-of-stock item; the customer accepts or rejects it. */
export const orderReplacementSchema = z.object({
  id: idSchema,
  orderItemId: idSchema,
  productId: idSchema.nullable(),
  name: z.string(),
  unitPriceCentavos: nonNegativeCentavosSchema,
  quantity: z.number().int().min(1),
  status: replacementStatusSchema,
  respondedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type OrderReplacement = z.infer<typeof orderReplacementSchema>;

export const orderSchema = z.object({
  id: idSchema,
  /** Short human code, e.g. EB-7K2Q9. */
  code: z.string(),
  /** Increments on every change; socket events carry it so clients can drop stale updates. */
  version: z.number().int().nonnegative(),
  type: orderTypeSchema,
  status: orderStatusSchema,
  prepUpdate: prepUpdateSchema.nullable(),
  customerId: idSchema.nullable(),
  merchantId: idSchema,
  riderId: idSchema.nullable(),
  /** Null for POS orders. */
  deliveryAddress: addressSnapshotSchema.nullable(),
  items: z.array(orderItemSchema).min(1),
  pricing: priceBreakdownSchema,
  paymentMethod: paymentMethodSchema,
  paymentStatus: paymentStatusSchema,
  voucherCode: z.string().nullable(),
  gift: giftDetailsSchema.nullable(),
  groupId: idSchema.nullable(),
  scheduledFor: timestampSchema.nullable(),
  notes: z.string().nullable(),
  etaAt: timestampSchema.nullable(),
  /** Merchant's promised prep time, set on accept. */
  prepTimeMinutes: z.number().int().positive().nullable(),
  replacements: z.array(orderReplacementSchema),
  placedAt: timestampSchema.nullable(),
  deliveredAt: timestampSchema.nullable(),
  cancelledAt: timestampSchema.nullable(),
  cancelReason: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Order = z.infer<typeof orderSchema>;

/** Merchant-app view: adds the customer's name and the money split. */
export const merchantOrderSchema = orderSchema.extend({
  customerName: z.string().nullable(),
  commissionCentavos: centavosSchema,
  /** May be negative (e.g. merchant-funded free delivery on a tiny order). */
  merchantNetCentavos: centavosSchema,
  /** Cancellation Protection credit when the customer cancelled after preparation started. */
  cancellationCompensationCentavos: nonNegativeCentavosSchema,
});
export type MerchantOrder = z.infer<typeof merchantOrderSchema>;

export const orderStatusEventSchema = z.object({
  id: idSchema,
  orderId: idSchema,
  from: orderStatusSchema.nullable(),
  to: orderStatusSchema,
  actor: orderActorSchema,
  actorUserId: idSchema.nullable(),
  reason: z.string().nullable(),
  createdAt: timestampSchema,
});
export type OrderStatusEvent = z.infer<typeof orderStatusEventSchema>;

/** Prices are never sent: the server re-prices the cart. */
export const createOrderInputSchema = z
  .object({
    cartId: idSchema,
    type: orderTypeSchema.exclude(['pos', 'subscription']).default('regular'),
    addressId: idSchema,
    paymentMethod: paymentMethodSchema,
    tipCentavos: nonNegativeCentavosSchema.default(0),
    notes: z.string().trim().max(300).nullable().default(null),
    scheduledFor: timestampSchema.nullable().default(null),
    gift: giftDetailsSchema.nullable().default(null),
    usePoints: z.number().int().nonnegative().default(0),
    roundUpDonation: z.boolean().default(false),
  })
  .refine((o) => o.type !== 'scheduled' || o.scheduledFor !== null, {
    message: 'scheduledFor is required for scheduled orders',
    path: ['scheduledFor'],
  })
  .refine((o) => o.type !== 'gift' || o.gift !== null, {
    message: 'gift details are required for gift orders',
    path: ['gift'],
  });
export type CreateOrderInput = z.input<typeof createOrderInputSchema>;

export const createPosOrderInputSchema = z.object({
  items: z
    .array(
      z.object({
        productId: idSchema,
        variantId: idSchema.nullable().default(null),
        quantity: z.number().int().min(1).max(999),
        modifierOptionIds: z.array(idSchema).default([]),
      }),
    )
    .min(1),
  paymentMethod: paymentMethodSchema.extract(['cod', 'gcash', 'maya', 'card']),
  customerPhone: phPhoneSchema.nullable().default(null),
  /** Cash tendered for change calculation; the server computes the total. */
  cashTenderedCentavos: nonNegativeCentavosSchema.nullable().default(null),
});
export type CreatePosOrderInput = z.input<typeof createPosOrderInputSchema>;

/** Request a status change. The server validates it with canTransition. */
export const transitionOrderInputSchema = z.object({
  to: orderStatusSchema,
  /** Order version the client saw; stale requests get CONFLICT. */
  version: z.number().int().nonnegative(),
  reason: z.string().trim().max(300).optional(),
});
export type TransitionOrderInput = z.infer<typeof transitionOrderInputSchema>;

export const prepUpdateInputSchema = z.object({
  prepUpdate: prepUpdateSchema,
  etaMinutes: z.number().int().min(0).max(240).optional(),
});
export type PrepUpdateInput = z.infer<typeof prepUpdateInputSchema>;

export const cancelOrderInputSchema = z.object({
  reason: z.string().trim().min(1).max(300),
  version: z.number().int().nonnegative(),
});
export type CancelOrderInput = z.infer<typeof cancelOrderInputSchema>;

/** Merchant reject uses the same shape as cancel. */
export const rejectOrderInputSchema = cancelOrderInputSchema;
export type RejectOrderInput = CancelOrderInput;

export const acceptOrderInputSchema = z.object({
  version: z.number().int().nonnegative(),
  /** Defaults to the suggested prep time. */
  prepTimeMinutes: z.number().int().min(1).max(240).optional(),
});
export type AcceptOrderInput = z.infer<typeof acceptOrderInputSchema>;

export const prepSuggestionSchema = z.object({
  minutes: z.number().int().positive(),
  /** False when there is too little history and the store's default prep time is used. */
  basedOnHistory: z.boolean(),
});
export type PrepSuggestion = z.infer<typeof prepSuggestionSchema>;

export const proposeReplacementInputSchema = z.object({
  orderItemId: idSchema,
  productId: idSchema,
  variantId: idSchema.nullable().default(null),
  /** Defaults to the original item's quantity. */
  quantity: z.number().int().min(1).max(999).optional(),
});
export type ProposeReplacementInput = z.input<typeof proposeReplacementInputSchema>;

export const respondReplacementInputSchema = z.object({ accept: z.boolean() });
export type RespondReplacementInput = z.infer<typeof respondReplacementInputSchema>;

export const customerBlockSchema = z.object({
  userId: idSchema,
  reason: z.string().nullable(),
  createdAt: timestampSchema,
});
export type CustomerBlock = z.infer<typeof customerBlockSchema>;

export const blockCustomerInputSchema = z.object({
  userId: idSchema,
  reason: z.string().trim().max(300).nullable().default(null),
});
export type BlockCustomerInput = z.input<typeof blockCustomerInputSchema>;

export const listOrdersQuerySchema = cursorPageQuerySchema.extend({
  status: z
    .union([orderStatusSchema, z.array(orderStatusSchema)])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  merchantId: idSchema.optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
});
export type ListOrdersQuery = z.input<typeof listOrdersQuerySchema>;

/** Order chat has two conversations: customer<->store and customer<->rider. */
export const ChatChannel = { MERCHANT: 'merchant', RIDER: 'rider' } as const;
export type ChatChannel = ValueOf<typeof ChatChannel>;
export const chatChannelSchema = zEnum(ChatChannel);

export const orderChatMessageSchema = z.object({
  id: idSchema,
  orderId: idSchema,
  channel: chatChannelSchema,
  senderId: idSchema,
  senderRole: userRoleSchema,
  body: z.string().min(1).max(1000),
  imageUrl: z.string().nullable(),
  createdAt: timestampSchema,
});
export type OrderChatMessage = z.infer<typeof orderChatMessageSchema>;

export const chatQuerySchema = cursorPageQuerySchema.extend({ channel: chatChannelSchema });
export type ChatQuery = z.input<typeof chatQuerySchema>;

export const sendChatMessageInputSchema = z.object({
  channel: chatChannelSchema,
  body: z.string().trim().min(1).max(1000),
});
export type SendChatMessageInput = z.infer<typeof sendChatMessageInputSchema>;
