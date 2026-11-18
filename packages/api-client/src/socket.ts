import { SocketEvent, type SocketEventPayload, socketEventSchemas } from '@ebalangay/shared';
import { io, type Socket } from 'socket.io-client';
import { type QueryKey, queryKeys } from './query-keys.js';

export interface CreateSocketOptions {
  url: string;
  getToken: () => string | null | Promise<string | null>;
  /** Called when the server rejects the handshake as unauthenticated. */
  refreshToken?: () => Promise<string | null>;
  appVersion?: string;
  /** Backoff: 1s doubling to 30s, +/-50% jitter. */
  reconnectionDelayMs?: number;
  reconnectionDelayMaxMs?: number;
}

export type AppSocket = Socket;

export function createSocket(options: CreateSocketOptions): AppSocket {
  const socket = io(options.url, {
    path: '/socket.io',
    transports: ['websocket'],
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: options.reconnectionDelayMs ?? 1000,
    reconnectionDelayMax: options.reconnectionDelayMaxMs ?? 30_000,
    randomizationFactor: 0.5,
    // Called on every (re)connect, so a refreshed token is always used.
    auth: (cb) => {
      void Promise.resolve(options.getToken()).then((token) =>
        cb({ token, appVersion: options.appVersion }),
      );
    },
  });

  // A middleware rejection does not auto-reconnect; refresh the token and retry once.
  let refreshing = false;
  socket.on('connect_error', (err) => {
    if (err.message !== 'UNAUTHENTICATED' || !options.refreshToken || refreshing) return;
    refreshing = true;
    void options
      .refreshToken()
      .then((token) => {
        if (token !== null) socket.connect();
      })
      .finally(() => {
        refreshing = false;
      });
  });
  return socket;
}

/** Cache entries an event makes stale. Screens then refetch the truth over REST. */
export function keysForEvent<E extends SocketEvent>(
  event: E,
  payload: SocketEventPayload<E>,
): QueryKey[] {
  const { id } = payload;
  switch (event) {
    case SocketEvent.ORDER_UPDATED:
    case SocketEvent.ORDER_PREP_UPDATED:
      return [queryKeys.orders.detail(id), queryKeys.orders.lists()];
    case SocketEvent.ORDER_CHAT_MESSAGE:
      return [queryKeys.orders.chat(id)];
    case SocketEvent.MERCHANT_NEW_ORDER:
    case SocketEvent.MERCHANT_ORDER_CANCELLED:
      return [queryKeys.orders.lists()];
    case SocketEvent.RIDER_JOB_OFFER:
    case SocketEvent.RIDER_JOB_CANCELLED:
      return [queryKeys.riders.jobs()];
    case SocketEvent.STORE_UPDATED:
      return [queryKeys.merchants.detail(id), queryKeys.merchants.all()];
    case SocketEvent.PRODUCT_UPDATED:
      return [queryKeys.products.detail(id), queryKeys.products.all()];
    case SocketEvent.SURGE_UPDATED:
      return [queryKeys.cart.all(), queryKeys.merchants.all()];
    case SocketEvent.ADMIN_METRICS:
      return [queryKeys.admin.metrics()];
    case SocketEvent.NOTIFICATION_CREATED:
      return [queryKeys.notifications.all()];
    // Live location is rendered from the event itself; nothing to refetch.
    case SocketEvent.RIDER_LOCATION:
      return [];
    default:
      return [];
  }
}

/** Remembers the newest version seen per event+entity so late/duplicate events are ignored. */
export class VersionTracker {
  private seen = new Map<string, number>();

  /** True if this payload is newer than anything seen before (and records it). */
  accept(event: string, payload: { id: string; version: number }): boolean {
    const key = `${event}:${payload.id}`;
    const last = this.seen.get(key);
    if (last !== undefined && payload.version <= last) return false;
    this.seen.set(key, payload.version);
    return true;
  }
}

/** Validate an incoming payload; returns null for malformed events. */
export function parseSocketPayload<E extends SocketEvent>(
  event: E,
  raw: unknown,
): SocketEventPayload<E> | null {
  const parsed = socketEventSchemas[event].safeParse(raw);
  return parsed.success ? (parsed.data as SocketEventPayload<E>) : null;
}
