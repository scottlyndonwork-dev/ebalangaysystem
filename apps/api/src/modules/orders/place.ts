/**
 * Checkout: re-prices the cart on the server, then creates the order and reserves stock,
 * voucher use and points in one transaction. Idempotent per (customer, Idempotency-Key).
 */
import { createHash } from 'node:crypto';
import type { createOrderInputSchema, OrderType, PricingIssue } from '@ebalangay/shared';
import type { z } from 'zod';
import type { Db, Tx } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import { changeStock, syncKeyProductAutoPause } from '../catalog/service.js';
import {
  addressSnapshot,
  type CartQuote,
  loadAddress,
  loadMerchantForCart,
} from '../carts/quote.js';
import { loadOwnCart, quoteOwnCart } from '../carts/service.js';
import { loadPrepSamples } from '../pricing/context.js';
import { suggestPrepMinutes } from '../pricing/eta.js';
import { loadOrder, orderCode, type OrderRow } from './service.js';
import { announceStatus, STOCK_REASON_ORDER, transitionOrder } from './transitions.js';

export type PlaceOrderInput = z.output<typeof createOrderInputSchema>;

/** Scheduled orders: at least this far ahead (on top of any merchant advance rule)... */
export const MIN_SCHEDULE_LEAD_MINUTES = 30;
/** ...and at most this far. */
export const MAX_SCHEDULE_DAYS = 3;
export const ROUND_UP_CAUSE = 'round_up';

const ONLINE_ONLY = new Set(['wallet', 'points']);

const ISSUE_ERRORS: Record<string, 'STORE_CLOSED' | 'OUT_OF_DELIVERY_ZONE' | 'OUT_OF_STOCK'> = {
  STORE_CLOSED: 'STORE_CLOSED',
  OUT_OF_DELIVERY_ZONE: 'OUT_OF_DELIVERY_ZONE',
  ITEM_UNAVAILABLE: 'OUT_OF_STOCK',
};

const requestHash = (input: PlaceOrderInput) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/** Merchant's suggested prep time for an order of `itemCount` items. */
export async function prepSuggestion(
  db: Db | Tx,
  merchant: { id: string; prepTimeMinutes: number },
  itemCount: number,
  now = new Date(),
) {
  const samples = await loadPrepSamples(db, merchant.id, now);
  return suggestPrepMinutes(samples, itemCount, merchant.prepTimeMinutes);
}

async function existingFor(db: Db, userId: string, key: string, hash: string) {
  const o = await db.order.findUnique({
    where: { customerId_idempotencyKey: { customerId: userId, idempotencyKey: key } },
    select: { id: true, idempotencyHash: true },
  });
  if (!o) return null;
  if (o.idempotencyHash !== hash) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'This Idempotency-Key was already used for a different order',
    );
  }
  return loadOrder(db, { id: o.id });
}

function checkSchedule(scheduledFor: Date | null, advanceOrderHours: number, now: Date): void {
  const leadMinutes = Math.max(MIN_SCHEDULE_LEAD_MINUTES, advanceOrderHours * 60);
  if (!scheduledFor) {
    if (advanceOrderHours > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `This store needs orders at least ${advanceOrderHours} hours ahead`,
        { advanceOrderHours },
      );
    }
    return;
  }
  const ahead = scheduledFor.getTime() - now.getTime();
  if (ahead < leadMinutes * 60_000) {
    throw new AppError('VALIDATION_FAILED', `Schedule at least ${leadMinutes} minutes ahead`, {
      minLeadMinutes: leadMinutes,
    });
  }
  if (ahead > MAX_SCHEDULE_DAYS * 86_400_000) {
    throw new AppError('VALIDATION_FAILED', `Schedule at most ${MAX_SCHEDULE_DAYS} days ahead`);
  }
}

function checkoutError(issues: PricingIssue[], warnings: unknown): AppError {
  const blocking = issues.find((i) => i.blocking);
  const code = (blocking && ISSUE_ERRORS[blocking.code]) ?? 'VALIDATION_FAILED';
  return new AppError(code, 'This cart cannot be checked out', { issues, warnings });
}

export async function placeOrder(
  db: Db,
  userId: string,
  input: PlaceOrderInput,
  idempotencyKey: string,
  now = new Date(),
): Promise<{ order: OrderRow; created: boolean }> {
  const hash = requestHash(input);
  const replay = await existingFor(db, userId, idempotencyKey, hash);
  if (replay) return { order: replay, created: false };

  try {
    const order = await db.$transaction((tx) =>
      createOrder(tx, userId, input, idempotencyKey, hash, now),
    );
    return { order, created: true };
  } catch (err) {
    // Same key submitted twice at once: the loser returns the winner's order.
    if (isUniqueViolation(err)) {
      const winner = await existingFor(db, userId, idempotencyKey, hash);
      if (winner) return { order: winner, created: false };
    }
    throw err;
  }
}

async function createOrder(
  tx: Tx,
  userId: string,
  input: PlaceOrderInput,
  idempotencyKey: string,
  hash: string,
  now: Date,
): Promise<OrderRow> {
  // Serialise checkouts of the same cart (double taps with different keys).
  await tx.$queryRaw`SELECT id FROM carts WHERE id = ${input.cartId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
  const cart = await loadOwnCart(tx, userId, input.cartId);
  const merchant = await loadMerchantForCart(tx, cart.merchantId, now);

  const blocked = await tx.merchantCustomerBlock.findUnique({
    where: { merchantId_userId: { merchantId: merchant.id, userId } },
    select: { userId: true },
  });
  if (blocked) {
    throw new AppError('FORBIDDEN', 'This store is not accepting orders from your account');
  }

  let type = input.type;
  if (cart.groupCartId) {
    const group = await tx.groupCart.findUnique({
      where: { id: cart.groupCartId },
      select: { status: true },
    });
    if (group?.status !== 'open' && group?.status !== 'locked') {
      throw new AppError('CONFLICT', 'The group order is closed', { groupStatus: group?.status });
    }
    type = 'group';
  } else if (type === 'group') {
    throw new AppError('VALIDATION_FAILED', 'Group orders are placed from a group cart');
  }
  if (ONLINE_ONLY.has(input.paymentMethod)) {
    throw new AppError('VALIDATION_FAILED', 'This payment method is not available yet');
  }

  const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : null;
  checkSchedule(scheduledFor, merchant.advanceOrderHours, now);

  const q = await quoteOwnCart(
    tx,
    userId,
    cart,
    {
      addressId: input.addressId,
      tipCentavos: input.tipCentavos,
      usePoints: input.usePoints,
      roundUpDonation: input.roundUpDonation,
      scheduledFor: input.scheduledFor ?? undefined,
    },
    { requireAddress: true, now },
  );
  if (!q.canCheckout) throw checkoutError(q.issues, q.warnings);
  if (cart.voucherCode && !q.quote.voucher) {
    throw new AppError('VOUCHER_INVALID', 'The voucher on this cart cannot be used', {
      issues: q.issues,
    });
  }
  if (type === 'wholesale' && !q.quote.isWholesale) {
    throw new AppError('VALIDATION_FAILED', 'This cart does not qualify for wholesale prices');
  }
  const order = await placeFromLines(tx, {
    userId,
    merchant,
    quote: q,
    addressId: input.addressId,
    type,
    paymentMethod: input.paymentMethod,
    scheduledFor,
    notes: input.notes,
    gift: input.gift,
    groupCartId: cart.groupCartId,
    idempotencyKey,
    idempotencyHash: hash,
    actor: 'customer',
    now,
  });
  if (cart.groupCartId) {
    await tx.groupCart.update({ where: { id: cart.groupCartId }, data: { status: 'ordered' } });
  }
  await tx.cart.delete({ where: { id: cart.id } });

  return order;
}

export interface PlaceFromLinesArgs {
  userId: string;
  merchant: Awaited<ReturnType<typeof loadMerchantForCart>>;
  /** A checkout-ready quote (canCheckout) of the lines being ordered. */
  quote: CartQuote;
  addressId: string;
  type: OrderType;
  paymentMethod: PlaceOrderInput['paymentMethod'];
  scheduledFor: Date | null;
  notes?: PlaceOrderInput['notes'];
  gift?: PlaceOrderInput['gift'];
  groupCartId?: string | null;
  subscriptionOrderId?: string | null;
  idempotencyKey?: string | null;
  idempotencyHash?: string | null;
  /** `system` for orders the workers place (subscriptions). */
  actor: 'customer' | 'system';
  now: Date;
}

/**
 * Creates the order from a priced quote and reserves stock, voucher use and points. Shared by
 * cart checkout and subscription runs; callers validate the schedule and payment method first.
 */
export async function placeFromLines(tx: Tx, a: PlaceFromLinesArgs): Promise<OrderRow> {
  const { userId, merchant, quote: q, scheduledFor, now } = a;
  const actorUserId = a.actor === 'customer' ? userId : null;
  const address = await loadAddress(tx, userId, a.addressId);
  if (!address) throw new AppError('VALIDATION_FAILED', 'Add a delivery address');

  const p = q.quote;
  const priced = new Map(p.lines.map((l) => [l.key, l]));
  const status = a.paymentMethod === 'cod' ? 'placed' : 'pending_payment';
  const etaAt =
    scheduledFor ?? (q.etaMinutes ? new Date(now.getTime() + q.etaMinutes * 60_000) : null);

  const created = await tx.order.create({
    data: {
      code: orderCode(),
      type: a.type,
      status,
      merchantId: merchant.id,
      customerId: userId,
      groupCartId: a.groupCartId ?? null,
      subscriptionOrderId: a.subscriptionOrderId ?? null,
      addressSnapshot: addressSnapshot(address),
      dropoffLat: address.lat,
      dropoffLng: address.lng,
      riderNotes: address.riderNotes,
      recipientName: a.gift?.recipientName ?? null,
      recipientPhone: a.gift?.recipientPhone ?? null,
      giftMessage: a.gift?.message ?? null,
      giftHidePrices: a.gift?.hidePrices ?? false,
      scheduledFor,
      notes: a.notes,
      subtotalCentavos: BigInt(p.subtotalCentavos),
      deliveryFeeCentavos: BigInt(p.deliveryFeeCentavos),
      serviceFeeCentavos: BigInt(p.serviceFeeCentavos),
      smallOrderFeeCentavos: BigInt(p.smallOrderFeeCentavos),
      discountCentavos: BigInt(p.discountCentavos),
      deliveryDiscountCentavos: BigInt(p.deliveryDiscountCentavos),
      tipCentavos: BigInt(p.tipCentavos),
      donationCentavos: BigInt(p.donationCentavos),
      pointsValueCentavos: BigInt(p.pointsValueCentavos),
      pointsRedeemed: p.pointsRedeemed,
      walletAppliedCentavos: BigInt(p.walletAppliedCentavos),
      totalCentavos: BigInt(p.totalCentavos),
      commissionCentavos: BigInt(p.commissionCentavos),
      merchantNetCentavos: BigInt(p.merchantNetCentavos),
      riderEarningCentavos: BigInt(p.riderEarningCentavos),
      surgeBps: p.surgeBps,
      voucherId: p.voucher?.id ?? null,
      paymentMethod: a.paymentMethod,
      idempotencyKey: a.idempotencyKey ?? null,
      idempotencyHash: a.idempotencyHash ?? null,
      etaAt,
      placedAt: status === 'placed' ? now : null,
      items: {
        create: q.lines.map((l) => {
          const pl = priced.get(l.selection.key);
          if (!pl) throw new Error(`unpriced line ${l.selection.key}`);
          return {
            productId: l.selection.productId,
            variantId: l.selection.variantId,
            name: l.name,
            variantName: l.variantName,
            quantity: l.selection.quantity,
            unitPriceCentavos: BigInt(pl.unitPriceCentavos),
            modifiers: l.modifiers.map((m) => ({
              name: m.name,
              priceDeltaCentavos: m.priceDeltaCentavos,
            })),
            lineTotalCentavos: BigInt(pl.lineTotalCentavos),
            notes: l.selection.notes,
          };
        }),
      },
      statusHistory: {
        create: {
          fromStatus: null,
          toStatus: status,
          actor: a.actor,
          actorUserId,
          createdAt: now,
        },
      },
    },
    select: { id: true },
  });

  // Stock: one decrement per product/variant; a shortfall here (race) aborts the order.
  const want = new Map<string, { productId: string; variantId: string | null; qty: number }>();
  for (const l of q.lines) {
    if (!l.trackInventory) continue;
    const k = `${l.selection.productId}|${l.selection.variantId ?? ''}`;
    const cur = want.get(k);
    if (cur) cur.qty += l.selection.quantity;
    else {
      want.set(k, {
        productId: l.selection.productId,
        variantId: l.selection.variantId,
        qty: l.selection.quantity,
      });
    }
  }
  for (const w of want.values()) {
    await changeStock(tx, {
      merchantId: merchant.id,
      productId: w.productId,
      variantId: w.variantId,
      mode: 'adjust',
      quantity: -w.qty,
      reason: STOCK_REASON_ORDER,
      orderId: created.id,
      actorUserId,
    });
  }
  if (want.size) await syncKeyProductAutoPause(tx, merchant.id);

  if (p.voucher) {
    const used = await tx.$executeRaw`
      UPDATE vouchers SET used_count = used_count + 1
      WHERE id = ${p.voucher.id}::uuid AND (usage_limit IS NULL OR used_count < usage_limit)`;
    if (used === 0) throw new AppError('VOUCHER_INVALID', 'This voucher has been fully used');
    await tx.voucherRedemption.create({
      data: {
        voucherId: p.voucher.id,
        userId,
        orderId: created.id,
        discountCentavos: BigInt(p.voucher.discountCentavos),
      },
    });
  }

  if (p.pointsRedeemed > 0) {
    const { count } = await tx.pointsAccount.updateMany({
      where: { userId, balance: { gte: p.pointsRedeemed } },
      data: { balance: { decrement: p.pointsRedeemed } },
    });
    if (count === 0) throw new AppError('INSUFFICIENT_BALANCE', 'Not enough points');
    const account = await tx.pointsAccount.findUniqueOrThrow({ where: { userId } });
    await tx.pointsTransaction.create({
      data: {
        accountId: account.id,
        type: 'redeem',
        points: -p.pointsRedeemed,
        balanceAfter: account.balance,
        orderId: created.id,
        description: 'Redeemed at checkout',
      },
    });
  }

  if (p.donationCentavos > 0) {
    await tx.donation.create({
      data: {
        userId,
        orderId: created.id,
        causeSlug: ROUND_UP_CAUSE,
        amountCentavos: BigInt(p.donationCentavos),
      },
    });
  }

  let order = await loadOrder(tx, { id: created.id });
  await announceStatus(tx, order, null, a.actor, null);

  // Auto-accept applies to ASAP orders; scheduled ones wait for the merchant.
  if (status === 'placed' && merchant.autoAccept && !scheduledFor) {
    const itemCount = q.lines.reduce((n, l) => n + l.selection.quantity, 0);
    const prep = await prepSuggestion(tx, merchant, itemCount, now);
    order = await transitionOrder(tx, {
      orderId: order.id,
      to: 'confirmed',
      actor: 'system',
      actorUserId: null,
      reason: 'auto_accept',
      data: { prepTimeMinutes: prep.minutes },
      now,
    });
  }
  return order;
}
