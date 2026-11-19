import { randomInt } from 'node:crypto';
import {
  cartItemSelectionSchema,
  createGroupCartInputSchema,
  type GroupCart,
  groupCartSchema,
  type GroupCartStatus,
  joinGroupCartInputSchema,
  setMemberReadyInputSchema,
  updateCartItemInputSchema,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Tx } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { authOf, requireAuth } from '../../plugins/auth.js';
import { sameSelection } from './lines.js';
import { loadMerchantForCart, quoteCart } from './quote.js';
import { assertSelectable, cartInclude, MAX_CART_LINES, selectionsOf, toCart } from './service.js';

const params = z.object({ groupCartId: z.uuid() });
const itemParams = params.extend({ itemId: z.uuid() });
const memberParams = params.extend({ memberId: z.uuid() });

/** No 0/O/1/I so codes read well aloud and in SMS. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () =>
  Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

const groupInclude = {
  members: { orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }] },
  carts: { include: cartInclude },
} satisfies Prisma.GroupCartInclude;
type GroupRow = Prisma.GroupCartGetPayload<{ include: typeof groupInclude }>;

/** The group, if the caller is a member; else 404. */
async function loadGroup(db: Db | Tx, groupCartId: string, userId: string) {
  const g = await db.groupCart.findUnique({ where: { id: groupCartId }, include: groupInclude });
  const me = g?.members.find((m) => m.userId === userId);
  if (!g || !me) throw new AppError('NOT_FOUND', 'Group order not found');
  return { group: g, me, isHost: g.hostUserId === userId };
}

function cartOf(g: GroupRow) {
  const cart = g.carts[0];
  if (!cart) throw new AppError('CONFLICT', 'This group order has ended');
  return cart;
}

function assertOpen(g: { status: string; deadlineAt: Date | null }, now = new Date()) {
  if (g.status !== 'open') {
    throw new AppError('CONFLICT', 'The group order is not open', { groupStatus: g.status });
  }
  if (g.deadlineAt && g.deadlineAt <= now) {
    throw new AppError('CONFLICT', 'The group order deadline has passed');
  }
}

/** Members see items and subtotals; delivery is priced only in the host's checkout quote. */
async function toGroupCart(db: Db, g: GroupRow): Promise<GroupCart> {
  const now = new Date();
  const cart = cartOf(g);
  const merchant = await loadMerchantForCart(db, g.merchantId, now);
  const q = await quoteCart(db, {
    userId: g.hostUserId,
    merchant,
    selections: selectionsOf(cart),
    address: null,
    requireAddress: false,
    voucherCode: cart.voucherCode,
    now,
  });
  const cartOut = toCart(cart, q);
  const memberCount = new Map<string, { items: number; subtotal: number }>();
  for (const i of cartOut.items) {
    if (!i.memberId) continue;
    const c = memberCount.get(i.memberId) ?? { items: 0, subtotal: 0 };
    c.items += i.quantity;
    if (i.isAvailable) c.subtotal += i.lineTotalCentavos;
    memberCount.set(i.memberId, c);
  }
  return {
    id: g.id,
    code: g.code,
    merchantId: g.merchantId,
    hostUserId: g.hostUserId,
    status: g.status as GroupCartStatus,
    deadlineAt: g.deadlineAt?.toISOString() ?? null,
    cart: cartOut,
    members: g.members.map((m) => ({
      id: m.id,
      userId: m.userId,
      displayName: m.displayName,
      isHost: m.userId === g.hostUserId,
      isReady: m.isReady,
      itemCount: memberCount.get(m.id)?.items ?? 0,
      subtotalCentavos: memberCount.get(m.id)?.subtotal ?? 0,
      amountDueCentavos: m.amountDueCentavos === null ? null : Number(m.amountDueCentavos),
    })),
    createdAt: g.createdAt.toISOString(),
  };
}

/**
 * /v1/group-carts — the host's cart for a store becomes a shared cart. Members join by code,
 * add their own items and mark themselves ready; the host checks out the cart via /v1/orders.
 */
export async function groupCartRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['group-carts'];
  const response = { 200: groupCartSchema };

  const render = async (groupCartId: string, userId: string) =>
    toGroupCart(app.db, (await loadGroup(app.db, groupCartId, userId)).group);

  r.post(
    '/',
    { schema: { tags, body: createGroupCartInputSchema, response }, preHandler: requireAuth },
    async (req) => {
      const userId = authOf(req).userId;
      const { merchantId, displayName, deadlineAt } = req.body;
      const now = new Date();
      await loadMerchantForCart(app.db, merchantId, now);
      if (deadlineAt && new Date(deadlineAt) <= now) {
        throw new AppError('VALIDATION_FAILED', 'Deadline must be in the future');
      }
      const id = await app.db.$transaction(async (tx) => {
        const cart = await tx.cart.upsert({
          where: { userId_merchantId: { userId, merchantId } },
          create: { userId, merchantId },
          update: {},
        });
        if (cart.groupCartId) {
          const existing = await tx.groupCart.findUnique({ where: { id: cart.groupCartId } });
          if (existing && (existing.status === 'open' || existing.status === 'locked')) {
            throw new AppError('CONFLICT', 'You already have a group order for this store', {
              groupCartId: existing.id,
            });
          }
        }
        let code = newCode();
        while (await tx.groupCart.findUnique({ where: { code }, select: { id: true } })) {
          code = newCode();
        }
        const g = await tx.groupCart.create({
          data: {
            hostUserId: userId,
            merchantId,
            code,
            deadlineAt: deadlineAt ? new Date(deadlineAt) : null,
          },
        });
        const host = await tx.groupCartMember.create({
          data: { groupCartId: g.id, userId, displayName },
        });
        await tx.cart.update({ where: { id: cart.id }, data: { groupCartId: g.id } });
        // Items already in the host's cart become the host's.
        await tx.cartItem.updateMany({
          where: { cartId: cart.id },
          data: { memberId: host.id },
        });
        return g.id;
      });
      return render(id, userId);
    },
  );

  r.post(
    '/join',
    { schema: { tags, body: joinGroupCartInputSchema, response }, preHandler: requireAuth },
    async (req) => {
      const userId = authOf(req).userId;
      const g = await app.db.groupCart.findUnique({ where: { code: req.body.code } });
      if (!g) throw new AppError('NOT_FOUND', 'Group order not found');
      const already = await app.db.groupCartMember.findUnique({
        where: { groupCartId_userId: { groupCartId: g.id, userId } },
      });
      if (!already) {
        assertOpen(g);
        await app.db.groupCartMember.create({
          data: { groupCartId: g.id, userId, displayName: req.body.displayName },
        });
      }
      return render(g.id, userId);
    },
  );

  r.get(
    '/:groupCartId',
    { schema: { tags, params, response }, preHandler: requireAuth },
    async (req) => render(req.params.groupCartId, authOf(req).userId),
  );

  r.post(
    '/:groupCartId/items',
    {
      schema: { tags, params, body: cartItemSelectionSchema, response },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const b = req.body;
      await app.db.$transaction(async (tx) => {
        const { group, me } = await loadGroup(tx, req.params.groupCartId, userId);
        assertOpen(group);
        const cart = cartOf(group);
        const sel = {
          productId: b.productId,
          variantId: b.variantId,
          modifierOptionIds: b.modifierOptionIds,
          notes: b.notes,
          memberId: me.id,
        };
        const existing = cart.items.find((i) =>
          sameSelection({ ...i, modifierOptionIds: i.modifierIds }, sel),
        );
        const quantity = (existing?.quantity ?? 0) + b.quantity;
        if (quantity > 999) throw new AppError('VALIDATION_FAILED', 'Quantity too large');
        if (!existing && cart.items.length >= MAX_CART_LINES) {
          throw new AppError('VALIDATION_FAILED', 'Cart is full');
        }
        await assertSelectable(tx, group.merchantId, { ...sel, quantity });
        if (existing) {
          await tx.cartItem.update({ where: { id: existing.id }, data: { quantity } });
        } else {
          await tx.cartItem.create({
            data: {
              cartId: cart.id,
              memberId: me.id,
              productId: b.productId,
              variantId: b.variantId,
              quantity,
              modifierIds: b.modifierOptionIds,
              notes: b.notes,
            },
          });
        }
        // Changing the order un-readies the member.
        await tx.groupCartMember.update({ where: { id: me.id }, data: { isReady: false } });
        await tx.cart.update({ where: { id: cart.id }, data: { updatedAt: new Date() } });
      });
      return render(req.params.groupCartId, userId);
    },
  );

  /** Members edit their own items; the host can edit anyone's. */
  const ownItem = async (tx: Tx, groupCartId: string, itemId: string, userId: string) => {
    const ctx = await loadGroup(tx, groupCartId, userId);
    assertOpen(ctx.group);
    const cart = cartOf(ctx.group);
    const item = cart.items.find((i) => i.id === itemId);
    if (!item || (!ctx.isHost && item.memberId !== ctx.me.id)) {
      throw new AppError('NOT_FOUND', 'Cart item not found');
    }
    return { ...ctx, cart, item };
  };

  r.patch(
    '/:groupCartId/items/:itemId',
    {
      schema: { tags, params: itemParams, body: updateCartItemInputSchema, response },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const { groupCartId, itemId } = req.params;
      await app.db.$transaction(async (tx) => {
        const { group, cart, item } = await ownItem(tx, groupCartId, itemId, userId);
        const next = {
          productId: item.productId,
          variantId: item.variantId,
          memberId: item.memberId,
          quantity: req.body.quantity ?? item.quantity,
          modifierOptionIds: req.body.modifierOptionIds ?? item.modifierIds,
          notes: req.body.notes === undefined ? item.notes : req.body.notes,
        };
        await assertSelectable(tx, group.merchantId, next);
        await tx.cartItem.update({
          where: { id: itemId },
          data: { quantity: next.quantity, modifierIds: next.modifierOptionIds, notes: next.notes },
        });
        await tx.cart.update({ where: { id: cart.id }, data: { updatedAt: new Date() } });
      });
      return render(groupCartId, userId);
    },
  );

  r.delete(
    '/:groupCartId/items/:itemId',
    { schema: { tags, params: itemParams, response }, preHandler: requireAuth },
    async (req) => {
      const userId = authOf(req).userId;
      const { groupCartId, itemId } = req.params;
      await app.db.$transaction(async (tx) => {
        const { cart } = await ownItem(tx, groupCartId, itemId, userId);
        await tx.cartItem.delete({ where: { id: itemId } });
        await tx.cart.update({ where: { id: cart.id }, data: { updatedAt: new Date() } });
      });
      return render(groupCartId, userId);
    },
  );

  r.put(
    '/:groupCartId/ready',
    {
      schema: { tags, params, body: setMemberReadyInputSchema, response },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const { group, me } = await loadGroup(app.db, req.params.groupCartId, userId);
      assertOpen(group);
      await app.db.groupCartMember.update({
        where: { id: me.id },
        data: { isReady: req.body.isReady },
      });
      return render(group.id, userId);
    },
  );

  const setStatus =
    (from: GroupCartStatus, to: GroupCartStatus) => async (groupCartId: string, userId: string) => {
      const { group, isHost } = await loadGroup(app.db, groupCartId, userId);
      if (!isHost) throw new AppError('FORBIDDEN', 'Only the host can do this');
      const n = await app.db.groupCart.updateMany({
        where: { id: group.id, status: from },
        data: { status: to },
      });
      if (n.count === 0) {
        throw new AppError('CONFLICT', `The group order is not ${from}`, {
          groupStatus: group.status,
        });
      }
    };
  const lock = setStatus('open', 'locked');
  const unlock = setStatus('locked', 'open');

  r.post(
    '/:groupCartId/lock',
    { schema: { tags, params, response }, preHandler: requireAuth },
    async (req) => {
      const userId = authOf(req).userId;
      await lock(req.params.groupCartId, userId);
      return render(req.params.groupCartId, userId);
    },
  );

  r.post(
    '/:groupCartId/unlock',
    { schema: { tags, params, response }, preHandler: requireAuth },
    async (req) => {
      const userId = authOf(req).userId;
      await unlock(req.params.groupCartId, userId);
      return render(req.params.groupCartId, userId);
    },
  );

  /** Leave (own member id) or, for the host, remove a member. Their items go with them. */
  r.delete(
    '/:groupCartId/members/:memberId',
    { schema: { tags, params: memberParams }, preHandler: requireAuth },
    async (req, reply) => {
      const userId = authOf(req).userId;
      const { group, me, isHost } = await loadGroup(app.db, req.params.groupCartId, userId);
      const target = group.members.find((m) => m.id === req.params.memberId);
      if (!target || (!isHost && target.id !== me.id)) {
        throw new AppError('NOT_FOUND', 'Member not found');
      }
      if (target.userId === group.hostUserId) {
        throw new AppError('VALIDATION_FAILED', 'The host cannot leave; cancel the group instead');
      }
      if (group.status !== 'open' && group.status !== 'locked') {
        throw new AppError('CONFLICT', 'This group order has ended');
      }
      await app.db.groupCartMember.delete({ where: { id: target.id } });
      return reply.status(204).send();
    },
  );

  /** Host cancels: members' items are dropped; the host keeps their own items as a normal cart. */
  r.delete(
    '/:groupCartId',
    { schema: { tags, params }, preHandler: requireAuth },
    async (req, reply) => {
      const userId = authOf(req).userId;
      const { group, me: host, isHost } = await loadGroup(app.db, req.params.groupCartId, userId);
      if (!isHost) throw new AppError('FORBIDDEN', 'Only the host can do this');
      if (group.status !== 'open' && group.status !== 'locked') {
        throw new AppError('CONFLICT', 'This group order has ended');
      }
      await app.db.$transaction(async (tx) => {
        await tx.groupCart.update({ where: { id: group.id }, data: { status: 'cancelled' } });
        for (const cart of group.carts) {
          await tx.cartItem.deleteMany({
            where: { cartId: cart.id, NOT: { memberId: host.id } },
          });
          await tx.cartItem.updateMany({ where: { cartId: cart.id }, data: { memberId: null } });
          await tx.cart.update({ where: { id: cart.id }, data: { groupCartId: null } });
        }
      });
      return reply.status(204).send();
    },
  );
}
