/**
 * Out-of-stock substitutes. The merchant proposes; the customer accepts (the line is swapped)
 * or rejects (the line is dropped). Totals move by the line delta only: fees, vouchers and
 * points stay as charged at checkout.
 */
import { applyBasisPoints, type OrderStatus, SocketEvent } from '@ebalangay/shared';
import type { Tx } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import { changeStock, syncKeyProductAutoPause } from '../catalog/service.js';
import { resolveLines, LINE_PROBLEM_MESSAGES } from '../carts/lines.js';
import { priceLine } from '../pricing/engine.js';
import { loadPricingSettings } from '../pricing/settings.js';
import { activeItems, loadOrder, type OrderRow, orderRooms, writeOutbox } from './service.js';
import { STOCK_REASON_ORDER } from './transitions.js';

/** Replacements are possible until the rider has the goods. */
const OPEN_STATUSES: readonly OrderStatus[] = ['placed', 'confirmed', 'preparing', 'ready'];

function assertOpen(o: OrderRow) {
  if (!OPEN_STATUSES.includes(o.status)) {
    throw new AppError('CONFLICT', 'Items can no longer be changed on this order', {
      status: o.status,
    });
  }
}

async function bumpAndAnnounce(
  tx: Tx,
  orderId: string,
  actor: 'merchant' | 'customer',
  push?: { userIds: string[]; params: Record<string, string> },
): Promise<OrderRow> {
  await tx.order.update({ where: { id: orderId }, data: { version: { increment: 1 } } });
  const o = await loadOrder(tx, { id: orderId });
  await writeOutbox(tx, {
    event: SocketEvent.ORDER_UPDATED,
    orderId: o.id,
    version: o.version,
    data: {
      status: o.status,
      previousStatus: o.status,
      actor,
      etaAt: o.etaAt?.toISOString() ?? null,
    },
    rooms: orderRooms(o),
    ...(push
      ? {
          push: {
            userIds: push.userIds,
            titleKey: 'notifications:replacementProposed.title',
            bodyKey: 'notifications:replacementProposed.body',
            params: push.params,
          },
        }
      : {}),
  });
  return o;
}

export async function proposeReplacement(
  tx: Tx,
  args: {
    merchantId: string;
    orderId: string;
    orderItemId: string;
    productId: string;
    variantId: string | null;
    quantity?: number;
    actorUserId: string;
    now?: Date;
  },
): Promise<OrderRow> {
  const o = await loadOrder(tx, { id: args.orderId, merchantId: args.merchantId });
  assertOpen(o);
  const item = activeItems(o).find((i) => i.id === args.orderItemId);
  if (!item) throw new AppError('NOT_FOUND', 'Order item not found');
  if (o.replacements.some((r) => r.orderItemId === item.id && r.status === 'proposed')) {
    throw new AppError('CONFLICT', 'A replacement for this item is already waiting');
  }

  const quantity = args.quantity ?? item.quantity;
  const [line] = await resolveLines(
    tx,
    args.merchantId,
    [
      {
        key: 'replacement',
        productId: args.productId,
        variantId: args.variantId,
        quantity,
        modifierOptionIds: [],
        notes: null,
      },
    ],
    args.now ?? new Date(),
  );
  if (!line || line.problem) {
    const problem = line?.problem ?? 'PRODUCT_UNAVAILABLE';
    throw new AppError(
      problem === 'OUT_OF_STOCK' ? 'OUT_OF_STOCK' : 'VALIDATION_FAILED',
      LINE_PROBLEM_MESSAGES[problem],
      { problem },
    );
  }
  const unit = priceLine(line.pricing, false).unitPriceCentavos;
  const name = line.variantName ? `${line.name} (${line.variantName})` : line.name;
  await tx.orderReplacement.create({
    data: {
      orderId: o.id,
      orderItemId: item.id,
      replacementProductId: args.productId,
      replacementName: name,
      replacementPriceCentavos: BigInt(unit),
      quantity,
      proposedById: args.actorUserId,
    },
  });
  const merchant = await tx.merchant.findUniqueOrThrow({
    where: { id: o.merchantId },
    select: { name: true },
  });
  return bumpAndAnnounce(
    tx,
    o.id,
    'merchant',
    o.customerId
      ? { userIds: [o.customerId], params: { store: merchant.name, item: name } }
      : undefined,
  );
}

export async function respondReplacement(
  tx: Tx,
  args: { customerId: string; orderId: string; replacementId: string; accept: boolean },
): Promise<OrderRow> {
  // Row lock: two responses (or a response and a status change) never interleave.
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${args.orderId}::uuid FOR UPDATE`;
  const o = await loadOrder(tx, { id: args.orderId, customerId: args.customerId });
  assertOpen(o);
  const r = o.replacements.find((x) => x.id === args.replacementId);
  if (!r) throw new AppError('NOT_FOUND', 'Replacement not found');
  if (r.status !== 'proposed') {
    throw new AppError('CONFLICT', 'This replacement was already answered', { status: r.status });
  }
  const item = activeItems(o).find((i) => i.id === r.orderItemId);
  if (!item) throw new AppError('CONFLICT', 'The item was already removed');
  if (!args.accept && activeItems(o).length === 1) {
    throw new AppError('VALIDATION_FAILED', 'This is the last item; cancel the order instead');
  }

  const now = new Date();
  const newLine = args.accept ? Number(r.replacementPriceCentavos) * r.quantity : 0;
  const delta = newLine - Number(item.lineTotalCentavos);

  await tx.orderItem.update({ where: { id: item.id }, data: { removedAt: now } });
  await tx.orderReplacement.update({
    where: { id: r.id },
    data: { status: args.accept ? 'accepted' : 'rejected', respondedAt: now },
  });
  // The original item is out of stock, so its reserved units are not put back.
  if (args.accept && r.replacementProductId) {
    await tx.orderItem.create({
      data: {
        orderId: o.id,
        productId: r.replacementProductId,
        name: r.replacementName,
        quantity: r.quantity,
        unitPriceCentavos: r.replacementPriceCentavos,
        lineTotalCentavos: BigInt(newLine),
        notes: item.notes,
      },
    });
    const product = await tx.product.findUnique({
      where: { id: r.replacementProductId },
      select: { trackInventory: true },
    });
    if (product?.trackInventory) {
      await changeStock(tx, {
        merchantId: o.merchantId,
        productId: r.replacementProductId,
        variantId: null,
        mode: 'adjust',
        quantity: -r.quantity,
        reason: STOCK_REASON_ORDER,
        orderId: o.id,
        actorUserId: args.customerId,
      });
      await syncKeyProductAutoPause(tx, o.merchantId);
    }
  }

  if (delta !== 0) {
    const merchant = await tx.merchant.findUniqueOrThrow({
      where: { id: o.merchantId },
      select: { commissionBps: true },
    });
    const bps = merchant.commissionBps ?? (await loadPricingSettings(tx)).defaultCommissionBps;
    const commissionDelta = applyBasisPoints(delta, bps);
    const total = Number(o.totalCentavos) + delta;
    await tx.order.update({
      where: { id: o.id },
      data: {
        subtotalCentavos: BigInt(Number(o.subtotalCentavos) + delta),
        totalCentavos: BigInt(Math.max(0, total)),
        commissionCentavos: BigInt(Number(o.commissionCentavos) + commissionDelta),
        merchantNetCentavos: BigInt(Number(o.merchantNetCentavos) + delta - commissionDelta),
      },
    });
  }
  return bumpAndAnnounce(tx, o.id, 'customer');
}
