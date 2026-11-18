import { createAdapter } from '@socket.io/redis-adapter';
import {
  parseRoom,
  roomCommandSchema,
  Rooms,
  SocketCommand,
  type RoomAck,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import type { AccessClaims, AuthContext, MfaClaims } from './auth.js';
import { ACCESS_COOKIE } from './auth.js';

export type SocketAuth = Omit<AuthContext, 'via'>;

/** Verifies the handshake token (auth.token for mobile, the access cookie for web). */
export function authenticateSocketToken(
  app: FastifyInstance,
  token: string | undefined,
): SocketAuth {
  if (!token) throw new Error('UNAUTHENTICATED');
  let claims: AccessClaims | MfaClaims;
  try {
    claims = app.jwt.verify<AccessClaims | MfaClaims>(token);
  } catch {
    throw new Error('UNAUTHENTICATED');
  }
  if (claims.typ !== 'access') throw new Error('UNAUTHENTICATED');
  return { userId: claims.sub, roles: claims.roles, app: claims.app, sessionId: claims.sid };
}

/** Room joins are authorised server-side; clients can only ask. */
export async function canJoinRoom(
  app: FastifyInstance,
  auth: SocketAuth,
  room: string,
  ip: string,
): Promise<boolean> {
  const parsed = parseRoom(room);
  if (!parsed) return false;
  const { kind, id } = parsed;
  switch (kind) {
    case 'user':
      return id === auth.userId;
    case 'admin':
      return (
        auth.app === 'admin-web' &&
        (auth.roles.includes('admin') || auth.roles.includes('super_admin')) &&
        app.isAdminIpAllowed(ip)
      );
    case 'merchant': {
      if (!id || (auth.app !== 'merchant' && auth.app !== 'merchant-web')) return false;
      const staff = await app.db.merchantStaff.findUnique({
        where: { merchantId_userId: { merchantId: id, userId: auth.userId } },
        select: { isActive: true },
      });
      return staff?.isActive === true;
    }
    case 'rider': {
      if (!id || auth.app !== 'rider') return false;
      const rider = await app.db.rider.findUnique({ where: { id }, select: { userId: true } });
      return rider?.userId === auth.userId;
    }
    case 'order': {
      if (!id) return false;
      const order = await app.db.order.findUnique({
        where: { id },
        select: { customerId: true, merchantId: true },
      });
      if (!order) return false;
      if (order.customerId === auth.userId) return true;
      if (auth.app !== 'merchant' && auth.app !== 'merchant-web') return false;
      const staff = await app.db.merchantStaff.findUnique({
        where: { merchantId_userId: { merchantId: order.merchantId, userId: auth.userId } },
        select: { isActive: true },
      });
      // Assigned riders join through the delivery flow (realtime phase).
      return staff?.isActive === true;
    }
    default:
      // Zone rooms open up with rider dispatch in the realtime phase.
      return false;
  }
}

/** Same client-IP rule as Fastify's trustProxy: trust only TRUST_PROXY_HOPS forwarded hops. */
export function socketIp(
  app: FastifyInstance,
  h: { address: string; headers: Record<string, string | string[] | undefined> },
): string {
  const hops = app.env.TRUST_PROXY_HOPS;
  const xff = h.headers['x-forwarded-for'];
  const list = (Array.isArray(xff) ? xff.join(',') : (xff ?? ''))
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (hops === 0 || list.length === 0) return h.address;
  return list[Math.max(0, list.length - hops)] ?? h.address;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/**
 * Socket.IO on the same HTTP server, scaled across instances with the Redis adapter.
 * Every socket auto-joins its user room; other rooms go through canJoinRoom.
 */
export function attachRealtime(app: FastifyInstance): Server {
  const allowed = new Set(app.env.CORS_ORIGINS);
  const io = new Server(app.server, {
    path: '/socket.io',
    cors: {
      origin: (origin, cb) => cb(null, origin === undefined || allowed.has(origin)),
      credentials: true,
    },
  });
  // The shared client is lazy with no offline queue; the adapter needs ordinary connections.
  const pub = app.redis.duplicate({ lazyConnect: false, enableOfflineQueue: true });
  const sub = app.redis.duplicate({ lazyConnect: false, enableOfflineQueue: true });
  io.adapter(createAdapter(pub, sub));

  io.use((socket, next) => {
    try {
      const fromAuth = (socket.handshake.auth as { token?: unknown }).token;
      const token =
        typeof fromAuth === 'string'
          ? fromAuth
          : cookieValue(socket.handshake.headers.cookie, ACCESS_COOKIE);
      socket.data.auth = authenticateSocketToken(app, token);
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket) => {
    const auth = socket.data.auth as SocketAuth;
    void socket.join(Rooms.user(auth.userId));
    socket.on(SocketCommand.JOIN, async (payload: unknown, ack?: (a: RoomAck) => void) => {
      const parsed = roomCommandSchema.safeParse(payload);
      const ok =
        parsed.success &&
        (await canJoinRoom(app, auth, parsed.data.room, socketIp(app, socket.handshake)));
      if (ok) await socket.join(parsed.data.room);
      ack?.(ok ? { ok: true } : { ok: false, error: 'FORBIDDEN' });
    });
    socket.on(SocketCommand.LEAVE, async (payload: unknown, ack?: (a: RoomAck) => void) => {
      const parsed = roomCommandSchema.safeParse(payload);
      if (parsed.success) await socket.leave(parsed.data.room);
      ack?.({ ok: parsed.success });
    });
  });

  app.addHook('onClose', async () => {
    await io.close();
    await Promise.allSettled([pub.quit(), sub.quit()]);
  });
  return io;
}
