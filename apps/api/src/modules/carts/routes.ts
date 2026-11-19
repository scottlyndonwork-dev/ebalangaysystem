import {
  addCartItemInputSchema,
  applyVoucherInputSchema,
  cartQuoteQuerySchema,
  cartSchema,
  checkoutQuoteSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  updateCartItemInputSchema,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Tx } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { authOf, requireAuth } from '../../plugins/auth.js';
import { cursorArgs, pageOf } from '../catalog/service.js';
import { sameSelection } from './lines.js';
import { loadMerchantForCart, normalizeVoucherCode } from './quote.js';
import {
  assertSelectable,
  type CartRow,
  cartInclude,
  loadOwnCart,
  MAX_CART_LINES,
  memberShares,
  type QuoteParams,
  quoteOwnCart,
  toCart,
} from './service.js';

const cartParams = z.object({ cartId: z.uuid() });
const itemParams = cartParams.extend({ itemId: z.uuid() });
const MAX_QTY = 999;

/** A cart that backs a group order may change only while the group is open. */
export async function assertCartEditable(tx: Tx, cart: Pick<CartRow, 'groupCartId'>) {
  if (!cart.groupCartId) return;
  const gc = await tx.groupCart.findUnique({
    where: { id: cart.groupCartId },
    select: { status: true },
  });
  if (gc && gc.status !== 'open') {
    throw new AppError('CONFLICT', 'The group order is locked', { groupStatus: gc.status });
  }
}

const touch = (tx: Tx, cartId: string) =>
  tx.cart.update({ where: { id: cartId }, data: { updatedAt: new Date() } });

/** /v1/carts — one cart per store per customer. Prices always come from the server. */
export async function cartRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['carts'];

  const render = async (userId: string, cartId: string, q: QuoteParams = {}) => {
    const cart = await loadOwnCart(app.db, userId, cartId);
    const quote = await quoteOwnCart(app.db, userId, cart, q, { requireAddress: false });
    return toCart(cart, quote);
  };

  r.get(
    '/',
    {
      schema: {
        tags,
        querystring: cursorPageQuerySchema,
        response: { 200: cursorPageSchema(cartSchema) },
      },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const rows = await app.db.cart.findMany({
        where: { userId },
        orderBy: { id: 'desc' },
        take: req.query.limit + 1,
        ...cursorArgs(req.query.cursor),
        select: { id: true },
      });
      const page = pageOf(rows, req.query.limit);
      const items = [];
      for (const c of page.items) items.push(await render(userId, c.id));
      return { items, nextCursor: page.nextCursor };
    },
  );

  r.get(
    '/:cartId',
    {
      schema: {
        tags,
        params: cartParams,
        querystring: cartQuoteQuerySchema,
        response: { 200: cartSchema },
      },
      preHandler: requireAuth,
    },
    async (req) => render(authOf(req).userId, req.params.cartId, req.query),
  );

  r.post(
    '/items',
    {
      schema: { tags, body: addCartItemInputSchema, response: { 200: cartSchema } },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const b = req.body;
      const now = new Date();
      await loadMerchantForCart(app.db, b.merchantId, now);
      const cartId = await app.db.$transaction(async (tx) => {
        const cart = await tx.cart.upsert({
          where: { userId_merchantId: { userId, merchantId: b.merchantId } },
          create: { userId, merchantId: b.merchantId },
          update: {},
          include: cartInclude,
        });
        await assertCartEditable(tx, cart);
        // In a group cart the host's own items carry the host's member id.
        const memberId = cart.groupCartId
          ? ((
              await tx.groupCartMember.findUnique({
                where: { groupCartId_userId: { groupCartId: cart.groupCartId, userId } },
                select: { id: true },
              })
            )?.id ?? null)
          : null;
        const sel = {
          productId: b.productId,
          variantId: b.variantId,
          modifierOptionIds: b.modifierOptionIds,
          notes: b.notes,
          memberId,
        };
        const existing = cart.items.find((i) =>
          sameSelection({ ...i, modifierOptionIds: i.modifierIds }, sel),
        );
        const quantity = (existing?.quantity ?? 0) + b.quantity;
        if (quantity > MAX_QTY) throw new AppError('VALIDATION_FAILED', 'Quantity too large');
        if (!existing && cart.items.length >= MAX_CART_LINES) {
          throw new AppError('VALIDATION_FAILED', 'Cart is full');
        }
        await assertSelectable(tx, b.merchantId, { ...sel, quantity }, now);
        if (existing) {
          await tx.cartItem.update({ where: { id: existing.id }, data: { quantity } });
        } else {
          await tx.cartItem.create({
            data: {
              cartId: cart.id,
              productId: b.productId,
              variantId: b.variantId,
              memberId,
              quantity,
              modifierIds: b.modifierOptionIds,
              notes: b.notes,
            },
          });
        }
        await touch(tx, cart.id);
        return cart.id;
      });
      return render(userId, cartId);
    },
  );

  r.patch(
    '/:cartId/items/:itemId',
    {
      schema: {
        tags,
        params: itemParams,
        body: updateCartItemInputSchema,
        response: { 200: cartSchema },
      },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const { cartId, itemId } = req.params;
      await app.db.$transaction(async (tx) => {
        const cart = await loadOwnCart(tx, userId, cartId);
        const item = cart.items.find((i) => i.id === itemId);
        if (!item) throw new AppError('NOT_FOUND', 'Cart item not found');
        await assertCartEditable(tx, cart);
        const next = {
          productId: item.productId,
          variantId: item.variantId,
          memberId: item.memberId,
          quantity: req.body.quantity ?? item.quantity,
          modifierOptionIds: req.body.modifierOptionIds ?? item.modifierIds,
          notes: req.body.notes === undefined ? item.notes : req.body.notes,
        };
        await assertSelectable(tx, cart.merchantId, next);
        await tx.cartItem.update({
          where: { id: itemId },
          data: { quantity: next.quantity, modifierIds: next.modifierOptionIds, notes: next.notes },
        });
        await touch(tx, cartId);
      });
      return render(userId, cartId);
    },
  );

  r.delete(
    '/:cartId/items/:itemId',
    {
      schema: { tags, params: itemParams, response: { 200: cartSchema } },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const { cartId, itemId } = req.params;
      await app.db.$transaction(async (tx) => {
        const cart = await loadOwnCart(tx, userId, cartId);
        if (!cart.items.some((i) => i.id === itemId)) {
          throw new AppError('NOT_FOUND', 'Cart item not found');
        }
        await assertCartEditable(tx, cart);
        await tx.cartItem.delete({ where: { id: itemId } });
        await touch(tx, cartId);
      });
      return render(userId, cartId);
    },
  );

  r.delete(
    '/:cartId',
    { schema: { tags, params: cartParams }, preHandler: requireAuth },
    async (req, reply) => {
      const userId = authOf(req).userId;
      await app.db.$transaction(async (tx) => {
        const cart = await loadOwnCart(tx, userId, req.params.cartId);
        // Emptying the host's cart ends the group order.
        if (cart.groupCartId) {
          await tx.groupCart.updateMany({
            where: { id: cart.groupCartId, status: { in: ['open', 'locked'] } },
            data: { status: 'cancelled' },
          });
        }
        await tx.cart.delete({ where: { id: cart.id } });
      });
      return reply.status(204).send();
    },
  );

  r.put(
    '/:cartId/voucher',
    {
      schema: {
        tags,
        params: cartParams,
        body: applyVoucherInputSchema,
        response: { 200: cartSchema },
      },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const cart = await loadOwnCart(app.db, userId, req.params.cartId);
      const code = normalizeVoucherCode(req.body.code);
      const v = await app.db.voucher.findUnique({ where: { code }, select: { id: true } });
      if (!v) throw new AppError('VOUCHER_INVALID', 'Voucher not found');
      // Eligibility (dates, limits, min spend) is re-checked on every quote and shown as warnings.
      await app.db.cart.update({ where: { id: cart.id }, data: { voucherCode: code } });
      return render(userId, cart.id);
    },
  );

  r.delete(
    '/:cartId/voucher',
    {
      schema: { tags, params: cartParams, response: { 200: cartSchema } },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const cart = await loadOwnCart(app.db, userId, req.params.cartId);
      await app.db.cart.update({ where: { id: cart.id }, data: { voucherCode: null } });
      return render(userId, cart.id);
    },
  );

  r.get(
    '/:cartId/quote',
    {
      schema: {
        tags,
        params: cartParams,
        querystring: cartQuoteQuerySchema,
        response: { 200: checkoutQuoteSchema },
      },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const now = new Date();
      const cart = await loadOwnCart(app.db, userId, req.params.cartId);
      const q = await quoteOwnCart(app.db, userId, cart, req.query, { requireAddress: true, now });

      let shares: ReturnType<typeof memberShares> = [];
      if (cart.groupCartId) {
        const members = await app.db.groupCartMember.findMany({
          where: { groupCartId: cart.groupCartId },
        });
        shares = memberShares(cart, q, members);
        await app.db.$transaction(
          shares.map((s) =>
            app.db.groupCartMember.update({
              where: { id: s.memberId },
              data: { amountDueCentavos: BigInt(s.amountDueCentavos) },
            }),
          ),
        );
      }

      const scheduled = req.query.scheduledFor ? new Date(req.query.scheduledFor) : null;
      const etaAt =
        q.etaMinutes === null
          ? null
          : new Date((scheduled ?? now).getTime() + (scheduled ? 0 : q.etaMinutes * 60_000));
      return {
        cart: toCart(cart, q),
        addressId: q.addressId,
        distanceMeters: q.distanceM,
        etaMinutes: q.etaMinutes,
        etaAt: etaAt?.toISOString() ?? null,
        isWholesale: q.quote.isWholesale,
        canCheckout: q.canCheckout,
        issues: q.issues,
        memberShares: shares,
      };
    },
  );
}
