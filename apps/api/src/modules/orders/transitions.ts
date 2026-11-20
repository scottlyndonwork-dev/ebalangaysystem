/**
 * The only code path that changes orders.status. Every move is validated by the shared state
 * machine, applied with an optimistic version check, logged to order_status_history and
 * announced through the transactional outbox, all in the caller's transaction.
 */
import {
  canTransition,
  formatCentavos,
  type OrderActor,
  type OrderStatus,
  Rooms,
  SocketEvent,
} from '@ebalangay/shared';
import type { Tx } from '../../db.js';
import type { DeliveryStatus, Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { syncKeyProductAutoPause, changeStock } from '../catalog/service.js';
import { cancellationCompensation } from '../pricing/engine.js';
import { loadPricingSettings } from '../pricing/settings.js';
import { loadOrder, type OrderRow, orderRooms, writeOutbox } from './service.js';

/** Inventory movement reasons written by orders. */
export const STOCK_REASON_ORDER = 'sale';
export const STOCK_REASON_ORDER_CANCELLED = 'cancel';

const AFTER_PICKUP: readonly OrderStatus[] = ['picked_up', 'on_the_way', 'rider_nearby'];

const STATUS_TIMESTAMP: Partial<Record<OrderStatus, keyof Prisma.OrderUncheckedUpdateInput>> = {
  placed: 'placedAt',
  confirmed: 'confirmedAt',
  preparing: 'preparingAt',
  ready: 'readyAt',
  picked_up: 'pickedUpAt',
  delivered: 'deliveredAt',
  cancelled: 'cancelledAt',
};

/** Order statuses that move the rider job along (single-order deliveries for now). */
const DELIVERY_STATUS: Partial<Record<OrderStatus, DeliveryStatus>> = {
  rider_at_merchant: 'at_merchant',
  picked_up: 'picked_up',
  delivered: 'delivered',
  cancelled: 'cancelled',
  failed: 'failed',
};
const DELIVERY_DONE: readonly DeliveryStatus[] = ['delivered', 'cancelled', 'failed'];

const CUSTOMER_PUSH: Partial<Record<OrderStatus, string>> = {
  confirmed: 'orderConfirmed',
  picked_up: 'orderPickedUp',
  rider_nearby: 'riderNearby',
  delivered: 'orderDelivered',
  cancelled: 'orderCancelled',
  failed: 'orderCancelled',
};
/** Critical alerts that also go out by SMS (cost: one Semaphore credit each). */
const CUSTOMER_SMS: Partial<Record<OrderStatus, string>> = {
  rider_nearby: 'riderNearby',
  delivered: 'orderDelivered',
};

export interface TransitionRequest {
  orderId: string;
  to: OrderStatus;
  actor: OrderActor;
  actorUserId: string | null;
  /** Version the caller saw; a different current version is a CONFLICT. */
  expectedVersion?: number;
  reason?: string | null;
  /** Extra columns written with the status (e.g. prepTimeMinutes, riderId, etaAt). */
  data?: Prisma.OrderUncheckedUpdateManyInput;
  now?: Date;
}

export async function merchantStaffUserIds(tx: Tx, merchantId: string): Promise<string[]> {
  const staff = await tx.merchantStaff.findMany({
    where: { merchantId, isActive: true },
    select: { userId: true },
  });
  return staff.map((s) => s.userId);
}

export async function transitionOrder(tx: Tx, req: TransitionRequest): Promise<OrderRow> {
  const now = req.now ?? new Date();
  const order = await loadOrder(tx, { id: req.orderId });
  const from = order.status;
  if (req.expectedVersion !== undefined && req.expectedVersion !== order.version) {
    throw new AppError('CONFLICT', 'The order changed; refresh and try again', {
      version: order.version,
      status: from,
    });
  }
  if (!canTransition(from, req.to, req.actor, { orderType: order.type })) {
    throw new AppError('INVALID_TRANSITION', `Cannot move order from ${from} to ${req.to}`, {
      from,
      to: req.to,
    });
  }

  const data: Prisma.OrderUncheckedUpdateManyInput = { ...req.data, status: req.to };
  const stamp = STATUS_TIMESTAMP[req.to];
  if (stamp) (data as Record<string, unknown>)[stamp] = now;
  if (req.to === 'cancelled' || req.to === 'failed') {
    data.cancelReason = req.reason ?? null;
    if (req.to === 'cancelled') data.cancelledBy = req.actor;
    // Cancellation Protection: the merchant already spent ingredients and time.
    if (req.to === 'cancelled' && req.actor === 'customer' && from === 'preparing') {
      const settings = await loadPricingSettings(tx);
      data.cancellationCompensationCentavos = BigInt(
        cancellationCompensation(Number(order.subtotalCentavos), true, settings),
      );
    }
  }
  if (req.to === 'delivered' && order.paymentMethod === 'cod') data.paymentStatus = 'paid';

  // Optimistic lock: a concurrent transition bumps the version first and this matches 0 rows.
  const { count } = await tx.order.updateMany({
    where: { id: order.id, version: order.version, status: from },
    data: { ...data, version: { increment: 1 } },
  });
  if (count === 0) {
    throw new AppError('CONFLICT', 'The order changed; refresh and try again');
  }
  await tx.orderStatusHistory.create({
    data: {
      orderId: order.id,
      fromStatus: from,
      toStatus: req.to,
      actor: req.actor,
      actorUserId: req.actorUserId,
      reason: req.reason ?? null,
      createdAt: now,
    },
  });

  const deliveryStatus = DELIVERY_STATUS[req.to];
  if (deliveryStatus && order.riderId) {
    const done = DELIVERY_DONE.includes(deliveryStatus);
    await tx.delivery.updateMany({
      where: { legs: { some: { orderId: order.id } }, status: { notIn: [...DELIVERY_DONE] } },
      data: {
        status: deliveryStatus,
        version: { increment: 1 },
        ...(done ? { completedAt: now } : {}),
      },
    });
  }

  if (req.to === 'cancelled' || req.to === 'failed') {
    await releaseOrderHolds(tx, order, !AFTER_PICKUP.includes(from), req.actorUserId);
  }

  const updated = await loadOrder(tx, { id: order.id });
  await announceStatus(tx, updated, from, req.actor, req.reason ?? null);
  return updated;
}

/** Write the outbox rows for a status change (also used for the initial placement). */
export async function announceStatus(
  tx: Tx,
  o: OrderRow,
  previous: OrderStatus | null,
  actor: OrderActor,
  reason: string | null,
): Promise<void> {
  const merchant = await tx.merchant.findUnique({
    where: { id: o.merchantId },
    select: { name: true },
  });
  // COD: the picked-up push becomes the cash reminder (push + SMS).
  const cod = o.status === 'picked_up' && o.paymentMethod === 'cod';
  const pushKey = cod ? 'codReminder' : CUSTOMER_PUSH[o.status];
  const smsKey = cod ? 'codReminder' : CUSTOMER_SMS[o.status];
  // Customers don't need a push for a change they made themselves.
  const notifyCustomer = pushKey && o.customerId && actor !== 'customer';
  await writeOutbox(tx, {
    event: SocketEvent.ORDER_UPDATED,
    orderId: o.id,
    version: o.version,
    data: {
      status: o.status,
      previousStatus: previous,
      actor,
      etaAt: o.etaAt?.toISOString() ?? null,
    },
    rooms: orderRooms(o),
    ...(notifyCustomer && o.customerId
      ? {
          push: {
            userIds: [o.customerId],
            titleKey: `notifications:${pushKey}.title`,
            bodyKey: `notifications:${pushKey}.body`,
            params: {
              store: merchant?.name ?? '',
              code: o.code,
              amount: formatCentavos(Number(o.totalCentavos)),
            },
            category: 'order',
            app: 'customer',
            dedupeKey: `order:${o.id}:${o.status}`,
            ...(smsKey ? { smsKey: `notifications:${smsKey}.sms` } : {}),
          },
        }
      : {}),
  });

  if (o.status === 'placed') {
    const itemCount = o.items.reduce((n, i) => n + i.quantity, 0);
    await writeOutbox(tx, {
      event: SocketEvent.MERCHANT_NEW_ORDER,
      orderId: o.id,
      version: o.version,
      data: { orderId: o.id, code: o.code, itemCount },
      rooms: [Rooms.merchant(o.merchantId)],
      push: {
        userIds: await merchantStaffUserIds(tx, o.merchantId),
        titleKey: 'notifications:newOrder.title',
        bodyKey: 'notifications:newOrder.body',
        params: { code: o.code, count: itemCount },
        category: 'order',
        app: 'merchant',
        dedupeKey: `order:${o.id}:new`,
      },
    });
  }
  if (o.status === 'cancelled' && actor !== 'merchant') {
    await writeOutbox(tx, {
      event: SocketEvent.MERCHANT_ORDER_CANCELLED,
      orderId: o.id,
      version: o.version,
      data: { orderId: o.id, reason },
      rooms: [Rooms.merchant(o.merchantId)],
    });
  }
}

/**
 * Undo what placement reserved: stock (only while the goods are still at the store), redeemed
 * points and the voucher use.
 */
async function releaseOrderHolds(
  tx: Tx,
  o: OrderRow,
  restoreStock: boolean,
  actorUserId: string | null,
): Promise<void> {
  if (restoreStock) {
    const moves = await tx.inventoryMovement.groupBy({
      by: ['productId', 'variantId'],
      where: { orderId: o.id },
      _sum: { delta: true },
    });
    let touched = false;
    for (const m of moves) {
      const net = m._sum.delta ?? 0;
      if (net >= 0) continue;
      await changeStock(tx, {
        merchantId: o.merchantId,
        productId: m.productId,
        variantId: m.variantId,
        mode: 'adjust',
        quantity: -net,
        reason: STOCK_REASON_ORDER_CANCELLED,
        orderId: o.id,
        actorUserId,
      });
      touched = true;
    }
    if (touched) await syncKeyProductAutoPause(tx, o.merchantId);
  }

  if (o.pointsRedeemed > 0 && o.customerId) {
    const account = await tx.pointsAccount.update({
      where: { userId: o.customerId },
      data: { balance: { increment: o.pointsRedeemed } },
    });
    await tx.pointsTransaction.create({
      data: {
        accountId: account.id,
        type: 'adjustment',
        points: o.pointsRedeemed,
        balanceAfter: account.balance,
        orderId: o.id,
        description: `Refund for order ${o.code}`,
      },
    });
  }

  const redemption = await tx.voucherRedemption.findUnique({ where: { orderId: o.id } });
  if (redemption) {
    await tx.voucherRedemption.delete({ where: { id: redemption.id } });
    await tx.voucher.update({
      where: { id: redemption.voucherId },
      data: { usedCount: { decrement: 1 } },
    });
  }
}
