import type { Cart, MemberShare } from '@ebalangay/shared';
import type { Db, Tx } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { priceLine, toPriceBreakdown } from '../pricing/engine.js';
import { LINE_PROBLEM_MESSAGES, type LineSelection, resolveLines } from './lines.js';
import {
  type CartQuote,
  loadAddress,
  loadMerchantForCart,
  quoteCart,
  splitByWeight,
} from './quote.js';

/** Hard cap on lines per cart. */
export const MAX_CART_LINES = 100;

export const cartInclude = {
  items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.CartInclude;
export type CartRow = Prisma.CartGetPayload<{ include: typeof cartInclude }>;

export const selectionsOf = (cart: CartRow): LineSelection[] =>
  cart.items.map((i) => ({
    key: i.id,
    productId: i.productId,
    variantId: i.variantId,
    quantity: i.quantity,
    modifierOptionIds: i.modifierIds,
    notes: i.notes,
    memberId: i.memberId,
  }));

export function toCart(cart: CartRow, q: CartQuote): Cart {
  const priced = new Map(q.quote.lines.map((l) => [l.key, l]));
  return {
    id: cart.id,
    merchantId: cart.merchantId,
    groupCartId: cart.groupCartId,
    items: q.lines.map((l) => {
      // Unavailable lines are not priced by the engine; show their list price.
      const p = priced.get(l.selection.key) ?? priceLine(l.pricing, false);
      return {
        id: l.selection.key,
        productId: l.selection.productId,
        variantId: l.selection.variantId,
        quantity: l.selection.quantity,
        modifierOptionIds: [...l.selection.modifierOptionIds],
        notes: l.selection.notes,
        name: l.name,
        variantName: l.variantName,
        imageUrl: l.imageUrl,
        modifierNames: l.modifiers.map((m) => m.name),
        unitPriceCentavos: p.unitPriceCentavos,
        lineTotalCentavos: p.lineTotalCentavos,
        isAvailable: l.problem === null,
        memberId: l.selection.memberId ?? null,
      };
    }),
    voucherCode: cart.voucherCode,
    pricing: toPriceBreakdown(q.quote),
    surgeBps: q.quote.surgeBps,
    pointsEarnable: q.quote.pointsEarnable,
    warnings: q.warnings,
    updatedAt: cart.updatedAt.toISOString(),
  };
}

/** The caller's cart, or 404 (missing and someone else's look the same). */
export async function loadOwnCart(db: Db | Tx, userId: string, cartId: string): Promise<CartRow> {
  const cart = await db.cart.findFirst({ where: { id: cartId, userId }, include: cartInclude });
  if (!cart) throw new AppError('NOT_FOUND', 'Cart not found');
  return cart;
}

export interface QuoteParams {
  addressId?: string;
  tipCentavos?: number;
  usePoints?: number;
  roundUpDonation?: boolean;
  scheduledFor?: string;
}

/** Price a cart for its owner (the host, for group carts). */
export async function quoteOwnCart(
  db: Db | Tx,
  userId: string,
  cart: CartRow,
  p: QuoteParams,
  opts: { requireAddress: boolean; now?: Date },
): Promise<CartQuote> {
  const now = opts.now ?? new Date();
  const merchant = await loadMerchantForCart(db, cart.merchantId, now);
  const address = await loadAddress(db, userId, p.addressId);
  return quoteCart(db, {
    userId,
    merchant,
    selections: selectionsOf(cart),
    address,
    requireAddress: opts.requireAddress,
    voucherCode: cart.voucherCode,
    usePoints: p.usePoints,
    tipCentavos: p.tipCentavos,
    roundUpDonation: p.roundUpDonation,
    now,
    at: p.scheduledFor ? new Date(p.scheduledFor) : now,
  });
}

/** Group carts: each member's own items plus a pro-rata share of everything else. */
export function memberShares(
  cart: CartRow,
  q: CartQuote,
  members: readonly { id: string; userId: string; displayName: string; joinedAt: Date }[],
): MemberShare[] {
  const memberOf = new Map(cart.items.map((i) => [i.id, i.memberId]));
  const subtotals = new Map<string, number>(members.map((m) => [m.id, 0]));
  for (const l of q.quote.lines) {
    const mid = memberOf.get(l.key);
    const current = mid ? subtotals.get(mid) : undefined;
    if (mid && current !== undefined) subtotals.set(mid, current + l.lineTotalCentavos);
  }
  const ordered = [...members].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  const due = splitByWeight(
    q.quote.totalCentavos,
    ordered.map((m) => ({ id: m.id, weight: subtotals.get(m.id) ?? 0 })),
  );
  return ordered.map((m) => ({
    memberId: m.id,
    userId: m.userId,
    displayName: m.displayName,
    subtotalCentavos: subtotals.get(m.id) ?? 0,
    amountDueCentavos: due.get(m.id) ?? 0,
  }));
}

/**
 * Validate one line before it is stored. The merged quantity is checked against stock;
 * other lines' stock conflicts surface later as cart warnings.
 */
export async function assertSelectable(
  db: Db | Tx,
  merchantId: string,
  sel: Omit<LineSelection, 'key'>,
  now = new Date(),
): Promise<void> {
  const [line] = await resolveLines(db, merchantId, [{ ...sel, key: 'new' }], now);
  if (!line?.problem) return;
  const message = LINE_PROBLEM_MESSAGES[line.problem];
  if (line.problem === 'OUT_OF_STOCK') throw new AppError('OUT_OF_STOCK', message);
  if (line.problem === 'PRODUCT_UNAVAILABLE') throw new AppError('NOT_FOUND', message);
  throw new AppError('VALIDATION_FAILED', message, { problem: line.problem });
}
