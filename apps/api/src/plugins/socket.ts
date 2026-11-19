import { createAdapter } from '@socket.io/redis-adapter';
import {
  isTerminalStatus,
  parseRoom,
  riderLocationPingSchema,
  roomCommandSchema,
  Rooms,
  SocketCommand,
  type RoomAck,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { AppError } from '../lib/errors.js';
import {
  approvedRiderId as requireApprovedRider,
  ingestRiderLocation,
} from '../modules/tracking/location.js';
import type { AccessClaims, AuthContext, MfaClaims } from './auth.js';
import { ACCESS_COOKIE } from './auth.js';

export type SocketAuth = Omit<AuthContext, 'via'> & {
  /** Access-token expiry (epoch seconds); the socket is dropped then and must reconnect. */
  exp: number;
};

/** Upper bound on rooms one socket may hold (its own user room included). */
export const MAX_ROOMS_PER_SOCKET = 50;

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
  const exp = (claims as { exp?: number }).exp;
  if (typeof exp !== 'number') throw new Error('UNAUTHENTICATED');
  return { userId: claims.sub, roles: claims.roles, app: claims.app, sessionId: claims.sid, exp };
}

const isMerchantApp = (auth: SocketAuth) => auth.app === 'merchant' || auth.app === 'merchant-web';

function isAdmin(app: FastifyInstance, auth: SocketAuth, ip: string): boolean {
  return (
    auth.app === 'admin-web' &&
    (auth.roles.includes('admin') || auth.roles.includes('super_admin')) &&
    app.isAdminIpAllowed(ip)
  );
}

async function isActiveStaff(app: FastifyInstance, merchantId: string, userId: string) {
  const staff = await app.db.merchantStaff.findUnique({
    where: { merchantId_userId: { merchantId, userId } },
    select: { isActive: true },
  });
  return staff?.isActive === true;
}

/** The caller's rider profile, only when using the rider app with an approved account. */
async function approvedRiderId(app: FastifyInstance, auth: SocketAuth): Promise<string | null> {
  if (auth.app !== 'rider') return null;
  const rider = await app.db.rider.findUnique({
    where: { userId: auth.userId },
    select: { id: true, verificationStatus: true },
  });
  return rider?.verificationStatus === 'approved' ? rider.id : null;
}

/**
 * Room joins are authorised server-side; clients can only ask. Checks hit the DB fresh, so
 * revoked staff/rider access stops new joins at once (existing sockets drop at token expiry).
 */
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
      return isAdmin(app, auth, ip);
    case 'merchant':
      return !!id && isMerchantApp(auth) && isActiveStaff(app, id, auth.userId);
    case 'rider': {
      if (!id || auth.app !== 'rider') return false;
      const rider = await app.db.rider.findUnique({ where: { id }, select: { userId: true } });
      return rider?.userId === auth.userId;
    }
    case 'order': {
      if (!id) return false;
      const order = await app.db.order.findUnique({
        where: { id },
        select: { customerId: true, merchantId: true, riderId: true, status: true },
      });
      if (!order) return false;
      if (auth.app === 'customer') return order.customerId === auth.userId;
      if (isMerchantApp(auth)) return isActiveStaff(app, order.merchantId, auth.userId);
      if (auth.app === 'rider') {
        // Only the assigned rider, and only while the job is live.
        if (!order.riderId || isTerminalStatus(order.status)) return false;
        return (await approvedRiderId(app, auth)) === order.riderId;
      }
      return isAdmin(app, auth, ip);
    }
    case 'zone': {
      if (!id) return false;
      if (auth.app === 'admin-web') return isAdmin(app, auth, ip);
      const riderId = await approvedRiderId(app, auth);
      if (!riderId) return false;
      const link = await app.db.riderZone.findUnique({
        where: { riderId_zoneId: { riderId, zoneId: id } },
        select: { riderId: true },
      });
      return !!link;
    }
  }
}

/** Pings closer together than this are dropped (the app sends one every ~5s). */
export const MIN_LOCATION_INTERVAL_MS = 1000;

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
    // Stateless JWTs can't be revoked mid-connection, so the socket lives no longer than its
    // token; the client reconnects with a fresh one and re-joins (and refetches).
    const expiry = setTimeout(
      () => socket.disconnect(true),
      Math.max(0, auth.exp * 1000 - Date.now()),
    );
    socket.on('disconnect', () => clearTimeout(expiry));
    // Joins awaiting their DB check hold a slot, so concurrent requests can't overshoot the cap.
    let pendingJoins = 0;

    socket.on(SocketCommand.JOIN, async (payload: unknown, ack?: (a: RoomAck) => void) => {
      const parsed = roomCommandSchema.safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, error: 'VALIDATION_FAILED' });
      const { room } = parsed.data;
      if (socket.rooms.has(room)) return ack?.({ ok: true });
      // socket.rooms also holds the socket's private id room.
      if (socket.rooms.size - 1 + pendingJoins >= MAX_ROOMS_PER_SOCKET) {
        return ack?.({ ok: false, error: 'TOO_MANY_ROOMS' });
      }
      let ok = false;
      pendingJoins++;
      try {
        ok = await canJoinRoom(app, auth, room, socketIp(app, socket.handshake));
      } catch (err) {
        app.log.error({ err, room }, 'socket room check failed');
      } finally {
        pendingJoins--;
      }
      if (ok && socket.connected) await socket.join(room);
      ack?.(ok ? { ok: true } : { ok: false, error: 'FORBIDDEN' });
    });
    let lastPingAt = 0;
    socket.on(
      SocketCommand.RIDER_LOCATION,
      async (payload: unknown, ack?: (a: RoomAck) => void) => {
        if (auth.app !== 'rider') return ack?.({ ok: false, error: 'FORBIDDEN' });
        const parsed = riderLocationPingSchema.safeParse(payload);
        if (!parsed.success) return ack?.({ ok: false, error: 'VALIDATION_FAILED' });
        const nowMs = Date.now();
        if (nowMs - lastPingAt < MIN_LOCATION_INTERVAL_MS) {
          return ack?.({ ok: false, error: 'RATE_LIMITED' });
        }
        lastPingAt = nowMs;
        try {
          const riderId = await requireApprovedRider(app.db, auth.userId);
          await ingestRiderLocation({ db: app.db, redis: app.redis, io, log: app.log }, riderId, [
            parsed.data,
          ]);
          ack?.({ ok: true });
        } catch (err) {
          if (err instanceof AppError) return ack?.({ ok: false, error: err.code });
          app.log.error({ err }, 'rider location failed');
          ack?.({ ok: false, error: 'INTERNAL' });
        }
      },
    );
    socket.on(SocketCommand.LEAVE, async (payload: unknown, ack?: (a: RoomAck) => void) => {
      const parsed = roomCommandSchema.safeParse(payload);
      // The user room is permanent: user-targeted events must always arrive.
      if (parsed.success && parsed.data.room !== Rooms.user(auth.userId)) {
        await socket.leave(parsed.data.room);
      }
      ack?.({ ok: parsed.success });
    });
  });

  app.realtime.io = io;
  app.addHook('onClose', async () => {
    app.realtime.io = null;
    await io.close();
    await Promise.allSettled([pub.quit(), sub.quit()]);
  });
  return io;
}
