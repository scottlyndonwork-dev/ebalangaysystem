import {
  type ChatChannel,
  chatQuerySchema,
  cursorPageSchema,
  isTerminalStatus,
  MerchantPermission,
  type OrderChatMessage,
  orderChatMessageSchema,
  Rooms,
  sendChatMessageInputSchema,
  SocketEvent,
  type UserRole,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { type AuthContext, authOf, requireAuth } from '../../plugins/auth.js';
import { cursorArgs, pageOf } from '../catalog/service.js';
import { writeOutbox } from './service.js';

const params = z.object({ orderId: z.uuid() });

interface Participant {
  side: 'customer' | 'merchant' | 'rider';
  senderRole: UserRole;
  /** Display name used in the push to the other side. */
  name: string;
}

type ChatOrder = {
  id: string;
  status: Parameters<typeof isTerminalStatus>[0];
  version: number;
  customerId: string | null;
  merchantId: string;
  riderId: string | null;
  rider: { userId: string } | null;
  merchant: { name: string };
};

/**
 * Who the caller is on this order, decided by the app they use: customer app -> the
 * customer, merchant apps -> store staff with orders.manage, rider app -> the assigned rider.
 * Anyone else gets 404.
 */
async function participantOf(db: Db, auth: AuthContext, o: ChatOrder): Promise<Participant> {
  const notFound = new AppError('NOT_FOUND', 'Order not found');
  if (auth.app === 'customer') {
    if (o.customerId !== auth.userId) throw notFound;
    const u = await db.user.findUnique({
      where: { id: auth.userId },
      select: { firstName: true },
    });
    return { side: 'customer', senderRole: 'customer', name: u?.firstName || 'Customer' };
  }
  if (auth.app === 'merchant' || auth.app === 'merchant-web') {
    const staff = await db.merchantStaff.findUnique({
      where: { merchantId_userId: { merchantId: o.merchantId, userId: auth.userId } },
      select: { isActive: true, rolePreset: true, permissions: true },
    });
    const allowed =
      staff?.isActive &&
      (staff.rolePreset === 'owner' ||
        staff.permissions.includes(MerchantPermission.ORDERS_MANAGE));
    if (!allowed) throw notFound;
    return {
      side: 'merchant',
      senderRole: staff.rolePreset === 'owner' ? 'merchant_owner' : 'merchant_staff',
      name: o.merchant.name,
    };
  }
  if (auth.app === 'rider' && o.rider?.userId === auth.userId) {
    return { side: 'rider', senderRole: 'rider', name: 'Rider' };
  }
  throw notFound;
}

function assertChannel(p: Participant, channel: ChatChannel, o: ChatOrder) {
  if (p.side !== 'customer' && p.side !== channel) {
    throw new AppError('FORBIDDEN', 'Not part of this conversation');
  }
  if (channel === 'rider' && !o.riderId) {
    throw new AppError('CONFLICT', 'No rider is assigned yet');
  }
}

async function loadChatOrder(db: Db, orderId: string): Promise<ChatOrder> {
  const o = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      version: true,
      customerId: true,
      merchantId: true,
      riderId: true,
      rider: { select: { userId: true } },
      merchant: { select: { name: true } },
    },
  });
  if (!o) throw new AppError('NOT_FOUND', 'Order not found');
  return o;
}

type MessageRow = NonNullable<Awaited<ReturnType<Db['orderChatMessage']['findFirst']>>>;

const toMessage = (m: MessageRow): OrderChatMessage => ({
  id: m.id,
  orderId: m.orderId,
  channel: m.channel as ChatChannel,
  senderId: m.senderId,
  senderRole: m.senderRole,
  body: m.body,
  imageUrl: m.imageUrl,
  createdAt: m.createdAt.toISOString(),
});

/** /v1/orders/:orderId/chat — customer<->store and customer<->rider conversations. */
export async function orderChatRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['orders'];

  r.get(
    '/:orderId/chat',
    {
      schema: {
        tags,
        params,
        querystring: chatQuerySchema,
        response: { 200: cursorPageSchema(orderChatMessageSchema) },
      },
      preHandler: requireAuth,
    },
    async (req) => {
      const o = await loadChatOrder(app.db, req.params.orderId);
      const p = await participantOf(app.db, authOf(req), o);
      const { channel, limit, cursor } = req.query;
      if (p.side !== 'customer' && p.side !== channel) {
        throw new AppError('FORBIDDEN', 'Not part of this conversation');
      }
      // Newest first; uuid v7 ids sort by time.
      const rows = await app.db.orderChatMessage.findMany({
        where: { orderId: o.id, channel },
        orderBy: { id: 'desc' },
        take: limit + 1,
        ...cursorArgs(cursor),
      });
      const page = pageOf(rows, limit);
      return { items: page.items.map(toMessage), nextCursor: page.nextCursor };
    },
  );

  r.post(
    '/:orderId/chat',
    {
      schema: {
        tags,
        params,
        body: sendChatMessageInputSchema,
        response: { 201: orderChatMessageSchema },
      },
      preHandler: requireAuth,
    },
    async (req, reply) => {
      const auth = authOf(req);
      const o = await loadChatOrder(app.db, req.params.orderId);
      const p = await participantOf(app.db, auth, o);
      const { channel, body } = req.body;
      assertChannel(p, channel, o);
      if (isTerminalStatus(o.status)) {
        throw new AppError('CONFLICT', 'Chat is closed for this order');
      }

      const message = await app.db.$transaction(async (tx) => {
        const m = await tx.orderChatMessage.create({
          data: { orderId: o.id, senderId: auth.userId, senderRole: p.senderRole, channel, body },
        });
        const otherSide =
          p.side === 'customer' ? (channel === 'merchant' ? 'merchant' : 'rider') : 'customer';
        // Party rooms only: the order room would leak rider chat to the store and vice versa.
        const rooms: string[] = [];
        let pushTo: string[] = [];
        if (o.customerId) rooms.push(Rooms.user(o.customerId));
        if (channel === 'merchant') rooms.push(Rooms.merchant(o.merchantId));
        if (channel === 'rider' && o.riderId) rooms.push(Rooms.rider(o.riderId));
        if (otherSide === 'customer' && o.customerId) pushTo = [o.customerId];
        if (otherSide === 'rider' && o.rider) pushTo = [o.rider.userId];
        // Staff see store chat in the merchant app via the merchant room; no push.
        await writeOutbox(tx, {
          event: SocketEvent.ORDER_CHAT_MESSAGE,
          orderId: o.id,
          version: o.version,
          data: toMessage(m),
          rooms,
          ...(pushTo.length
            ? {
                push: {
                  userIds: pushTo,
                  titleKey: 'notifications:chatMessage.title',
                  bodyKey: 'notifications:chatMessage.body',
                  params: { from: p.name, text: body.slice(0, 120) },
                  category: 'order',
                  app: otherSide === 'rider' ? 'rider' : 'customer',
                },
              }
            : {}),
        });
        return m;
      });
      return reply.status(201).send(toMessage(message));
    },
  );
}
