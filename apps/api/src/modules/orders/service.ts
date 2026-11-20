import { randomInt } from 'node:crypto';
import {
  type AddressSnapshot,
  type MerchantOrder,
  type Order,
  type OrderReplacement,
  Rooms,
  type SocketEvent,
} from '@ebalangay/shared';
import type { Db, Tx } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import type { OutboxPush } from '../notifications/payload.js';

export const orderInclude = {
  items: { orderBy: [{ id: 'asc' }] },
  replacements: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  voucher: { select: { code: true } },
} satisfies Prisma.OrderInclude;
export type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Item lines a row's totals are based on (rejected replacements are excluded). */
export const activeItems = (o: Pick<OrderRow, 'items'>) => o.items.filter((i) => !i.removedAt);

function toReplacement(r: OrderRow['replacements'][number]): OrderReplacement {
  return {
    id: r.id,
    orderItemId: r.orderItemId,
    productId: r.replacementProductId,
    name: r.replacementName,
    unitPriceCentavos: Number(r.replacementPriceCentavos),
    quantity: r.quantity,
    status: r.status as OrderReplacement['status'],
    respondedAt: iso(r.respondedAt),
    createdAt: r.createdAt.toISOString(),
  };
}

export function toOrder(o: OrderRow): Order {
  const total = Number(o.totalCentavos);
  const wallet = Number(o.walletAppliedCentavos);
  return {
    id: o.id,
    code: o.code,
    version: o.version,
    type: o.type,
    status: o.status,
    prepUpdate: o.prepUpdate,
    customerId: o.customerId,
    merchantId: o.merchantId,
    riderId: o.riderId,
    deliveryAddress: (o.addressSnapshot as AddressSnapshot | null) ?? null,
    items: o.items.map((i) => ({
      id: i.id,
      productId: i.productId ?? '',
      variantId: i.variantId,
      name: i.name,
      variantName: i.variantName,
      quantity: i.quantity,
      unitPriceCentavos: Number(i.unitPriceCentavos),
      modifiers: i.modifiers as { name: string; priceDeltaCentavos: number }[],
      lineTotalCentavos: Number(i.lineTotalCentavos),
      notes: i.notes,
      removedAt: iso(i.removedAt),
    })),
    pricing: {
      subtotalCentavos: Number(o.subtotalCentavos),
      deliveryFeeCentavos: Number(o.deliveryFeeCentavos),
      serviceFeeCentavos: Number(o.serviceFeeCentavos),
      smallOrderFeeCentavos: Number(o.smallOrderFeeCentavos),
      discountCentavos: Number(o.discountCentavos),
      deliveryDiscountCentavos: Number(o.deliveryDiscountCentavos),
      pointsRedeemed: o.pointsRedeemed,
      pointsValueCentavos: Number(o.pointsValueCentavos),
      tipCentavos: Number(o.tipCentavos),
      donationCentavos: Number(o.donationCentavos),
      totalCentavos: total,
      walletAppliedCentavos: wallet,
      amountDueCentavos: total - wallet,
    },
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    voucherCode: o.voucher?.code ?? null,
    gift:
      o.type === 'gift' && o.recipientName && o.recipientPhone
        ? {
            recipientName: o.recipientName,
            recipientPhone: o.recipientPhone,
            message: o.giftMessage,
            hidePrices: o.giftHidePrices,
          }
        : null,
    groupId: o.groupCartId,
    scheduledFor: iso(o.scheduledFor),
    notes: o.notes,
    etaAt: iso(o.etaAt),
    prepTimeMinutes: o.prepTimeMinutes,
    replacements: o.replacements.map(toReplacement),
    placedAt: iso(o.placedAt),
    deliveredAt: iso(o.deliveredAt),
    cancelledAt: iso(o.cancelledAt),
    cancelReason: o.cancelReason,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

export function toMerchantOrder(o: OrderRow, customerName: string | null): MerchantOrder {
  return {
    ...toOrder(o),
    customerName,
    commissionCentavos: Number(o.commissionCentavos),
    merchantNetCentavos: Number(o.merchantNetCentavos),
    cancellationCompensationCentavos: Number(o.cancellationCompensationCentavos),
  };
}

// No 0/O/1/I so codes survive being read out over the phone.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function orderCode(): string {
  let s = 'EB-';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** 404 for missing and not-yours alike, so ids can't be probed. */
export async function loadOrder(db: Db | Tx, where: Prisma.OrderWhereInput): Promise<OrderRow> {
  const o = await db.order.findFirst({ where, include: orderInclude });
  if (!o) throw new AppError('NOT_FOUND', 'Order not found');
  return o;
}

export interface OutboxInput {
  event: SocketEvent;
  orderId: string;
  version: number;
  data: Record<string, unknown>;
  rooms: string[];
  push?: OutboxPush;
}

/** Written in the same transaction as the change; the relay worker (2C) delivers it after commit. */
export async function writeOutbox(tx: Tx, e: OutboxInput): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      event: e.event,
      aggregateType: 'order',
      aggregateId: e.orderId,
      version: e.version,
      payload: {
        id: e.orderId,
        version: e.version,
        occurredAt: new Date().toISOString(),
        data: e.data,
      } as Prisma.InputJsonValue,
      rooms: [...new Set(e.rooms)],
      ...(e.push && e.push.userIds.length ? { push: e.push as Prisma.InputJsonValue } : {}),
    },
  });
}

/** Rooms everyone involved in an order listens on. */
export function orderRooms(o: {
  id: string;
  customerId: string | null;
  merchantId: string;
  riderId: string | null;
}): string[] {
  const rooms: string[] = [Rooms.order(o.id), Rooms.merchant(o.merchantId)];
  if (o.customerId) rooms.push(Rooms.user(o.customerId));
  if (o.riderId) rooms.push(Rooms.rider(o.riderId));
  return rooms;
}
