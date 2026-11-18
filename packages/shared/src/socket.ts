import { z } from 'zod';
import { orderStatusSchema, prepUpdateSchema } from './enums.js';
import { orderActorSchema } from './order-state-machine.js';
import { basisPointsSchema, idSchema, latLngSchema, timestampSchema } from './schemas/common.js';
import { notificationSchema } from './schemas/engagement.js';
import { orderChatMessageSchema } from './schemas/order.js';
import { jobOfferSchema } from './schemas/rider.js';

/**
 * Socket events are hints, not truth: clients refetch the entity over REST when they
 * see a newer version, and refetch everything on reconnect.
 */
export const SocketEvent = {
  ORDER_UPDATED: 'order.updated',
  ORDER_PREP_UPDATED: 'order.prep_updated',
  ORDER_CHAT_MESSAGE: 'order.chat_message',
  RIDER_LOCATION: 'rider.location',
  RIDER_JOB_OFFER: 'rider.job_offer',
  RIDER_JOB_CANCELLED: 'rider.job_cancelled',
  MERCHANT_NEW_ORDER: 'merchant.new_order',
  MERCHANT_ORDER_CANCELLED: 'merchant.order_cancelled',
  STORE_UPDATED: 'store.updated',
  PRODUCT_UPDATED: 'product.updated',
  SURGE_UPDATED: 'surge.updated',
  ADMIN_METRICS: 'admin.metrics',
  NOTIFICATION_CREATED: 'notification.created',
} as const;
export type SocketEvent = (typeof SocketEvent)[keyof typeof SocketEvent];

/** Client -> server control messages. Joins are auth-checked server-side. */
export const SocketCommand = { JOIN: 'room.join', LEAVE: 'room.leave' } as const;
export const roomCommandSchema = z.object({ room: z.string().min(1).max(100) });
export const roomAckSchema = z.object({ ok: z.boolean(), error: z.string().optional() });
export type RoomAck = z.infer<typeof roomAckSchema>;

/** Every server -> client payload: entity id, entity version, when, and event data. */
export const socketEnvelope = <T extends z.ZodType>(data: T) =>
  z.object({
    /** Id of the entity the event is about (order id, rider id, ...). */
    id: idSchema,
    /** Entity version after the change; drop events older than what you have. */
    version: z.number().int().nonnegative(),
    occurredAt: timestampSchema,
    data,
  });

export const socketEventSchemas = {
  [SocketEvent.ORDER_UPDATED]: socketEnvelope(
    z.object({
      status: orderStatusSchema,
      previousStatus: orderStatusSchema.nullable(),
      actor: orderActorSchema,
      etaAt: timestampSchema.nullable(),
    }),
  ),
  [SocketEvent.ORDER_PREP_UPDATED]: socketEnvelope(
    z.object({ prepUpdate: prepUpdateSchema, etaAt: timestampSchema.nullable() }),
  ),
  [SocketEvent.ORDER_CHAT_MESSAGE]: socketEnvelope(orderChatMessageSchema),
  [SocketEvent.RIDER_LOCATION]: socketEnvelope(
    latLngSchema.extend({
      orderId: idSchema.nullable(),
      heading: z.number().min(0).max(360).nullable(),
      etaSeconds: z.number().int().nonnegative().nullable(),
    }),
  ),
  [SocketEvent.RIDER_JOB_OFFER]: socketEnvelope(jobOfferSchema),
  [SocketEvent.RIDER_JOB_CANCELLED]: socketEnvelope(
    z.object({ deliveryId: idSchema, orderId: idSchema, reason: z.string() }),
  ),
  [SocketEvent.MERCHANT_NEW_ORDER]: socketEnvelope(
    z.object({ orderId: idSchema, code: z.string(), itemCount: z.number().int().positive() }),
  ),
  [SocketEvent.MERCHANT_ORDER_CANCELLED]: socketEnvelope(
    z.object({ orderId: idSchema, reason: z.string().nullable() }),
  ),
  [SocketEvent.STORE_UPDATED]: socketEnvelope(
    z.object({ isOpen: z.boolean(), pausedUntil: timestampSchema.nullable() }),
  ),
  [SocketEvent.PRODUCT_UPDATED]: socketEnvelope(
    z.object({
      merchantId: idSchema,
      isAvailable: z.boolean(),
      stockQuantity: z.number().int().nonnegative().nullable(),
    }),
  ),
  [SocketEvent.SURGE_UPDATED]: socketEnvelope(z.object({ surgeBps: basisPointsSchema })),
  [SocketEvent.ADMIN_METRICS]: socketEnvelope(
    z.object({
      activeOrders: z.number().int().nonnegative(),
      onlineRiders: z.number().int().nonnegative(),
      openMerchants: z.number().int().nonnegative(),
      ordersLastHour: z.number().int().nonnegative(),
    }),
  ),
  [SocketEvent.NOTIFICATION_CREATED]: socketEnvelope(notificationSchema),
} satisfies Record<SocketEvent, z.ZodType>;

export type SocketEventPayload<E extends SocketEvent> = z.infer<(typeof socketEventSchemas)[E]>;

export const Rooms = {
  user: (id: string) => `user:${id}` as const,
  order: (id: string) => `order:${id}` as const,
  merchant: (id: string) => `merchant:${id}` as const,
  rider: (id: string) => `rider:${id}` as const,
  zone: (id: string) => `zone:${id}` as const,
  admin: () => 'admin' as const,
};
export type RoomKind = keyof typeof Rooms;

export function parseRoom(room: string): { kind: RoomKind; id: string | null } | null {
  if (room === 'admin') return { kind: 'admin', id: null };
  const m = /^(user|order|merchant|rider|zone):([0-9a-f-]{36})$/i.exec(room);
  return m ? { kind: m[1] as RoomKind, id: m[2] ?? null } : null;
}
