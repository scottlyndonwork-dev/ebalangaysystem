/**
 * Rider GPS (rule 8): pings go to Redis GEO + a last-seen hash and are relayed straight to the
 * order rooms of the rider's live jobs. Positions are ephemeral, so they skip the outbox;
 * breadcrumbs are queued in Redis and written to Postgres in batches by a worker.
 */
import { randomUUID } from 'node:crypto';
import {
  type OrderStatus,
  type RiderLocationPing,
  type RiderLocationResult,
  Rooms,
  SocketEvent,
  type SocketEventPayload,
} from '@ebalangay/shared';
import type { Server } from 'socket.io';
import type { Db } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import { haversineM } from '../../lib/geo.js';
import type { RedisClient } from '../../redis.js';
import { transitionOrder } from '../orders/transitions.js';
import { ETA } from '../pricing/eta.js';

export const LocationKeys = {
  /** GEO set of every rider's latest position (member = rider id). */
  geo: 'eb:riders:geo',
  /** Hash: lat, lng, heading, speed, accuracy, at (epoch ms of the ping). */
  last: (riderId: string) => `eb:rider:loc:${riderId}`,
  /** Monotonic per-rider counter, used as the socket envelope version. */
  seq: (riderId: string) => `eb:rider:locseq:${riderId}`,
  /** List of JSON breadcrumbs waiting for the batch writer. */
  crumbs: 'eb:breadcrumbs:pending',
  /** Riders whose riders.last_* snapshot is behind Redis. */
  dirty: 'eb:riders:loc-dirty',
  flushLock: 'eb:breadcrumbs:lock',
} as const;

/** A rider with no ping for this long drops out of last-seen. */
export const LAST_SEEN_TTL_SECONDS = 15 * 60;
/** Older pings (e.g. a long-offline queue) are dropped. */
export const MAX_PING_AGE_MS = 10 * 60_000;
/** Tolerated clock skew for pings dated in the future. */
export const MAX_PING_SKEW_MS = 30_000;
/** "Rider nearby" fires when the drive to the drop-off is about this short. */
export const NEARBY_ETA_SECONDS = 120;

/** Orders whose room sees the rider's position. */
const LIVE: readonly OrderStatus[] = [
  'rider_assigned',
  'rider_at_merchant',
  'picked_up',
  'on_the_way',
  'rider_nearby',
];
/** Rider is carrying the order: show the ETA to the drop-off. */
const EN_ROUTE: readonly OrderStatus[] = ['picked_up', 'on_the_way', 'rider_nearby'];

export interface Breadcrumb {
  id: string;
  deliveryId: string;
  riderId: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  speedMps: number | null;
  heading: number | null;
  recordedAt: string;
}

export interface LocationDeps {
  db: Db;
  redis: RedisClient;
  io: Server | null;
  log: { warn(obj: object, msg: string): void };
}

/** Same road factor and city speed as the order ETA. */
export function driveSeconds(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
  const metres = haversineM(from, to) * ETA.roadFactor;
  return Math.ceil(metres / (ETA.speedKmh / 3.6));
}

/** The caller's rider id; only approved riders may report a position. */
export async function approvedRiderId(db: Db, userId: string): Promise<string> {
  const rider = await db.rider.findUnique({
    where: { userId },
    select: { id: true, verificationStatus: true },
  });
  if (rider?.verificationStatus !== 'approved') {
    throw new AppError('FORBIDDEN', 'Only approved riders can share a location');
  }
  return rider.id;
}

export async function ingestRiderLocation(
  deps: LocationDeps,
  riderId: string,
  pings: RiderLocationPing[],
  now = new Date(),
): Promise<RiderLocationResult> {
  const { db, redis } = deps;
  const storedAt = Number((await redis.hget(LocationKeys.last(riderId), 'at')) ?? 0);
  // Retried or replayed batches carry pings already seen; only newer ones count.
  const fresh = pings
    .map((p) => ({ ...p, at: Date.parse(p.recordedAt) }))
    .filter(
      (p) =>
        p.at > storedAt &&
        p.at >= now.getTime() - MAX_PING_AGE_MS &&
        p.at <= now.getTime() + MAX_PING_SKEW_MS,
    )
    .sort((a, b) => a.at - b.at);
  const latest = fresh.at(-1);
  if (!latest) return { accepted: 0, nearbyOrderIds: [] };

  const orders = await db.order.findMany({
    where: { riderId, status: { in: [...LIVE] } },
    select: {
      id: true,
      version: true,
      status: true,
      dropoffLat: true,
      dropoffLng: true,
      deliveryLegs: { where: { kind: 'dropoff' }, select: { deliveryId: true }, take: 1 },
    },
  });
  const deliveryIds = [...new Set(orders.flatMap((o) => o.deliveryLegs.map((l) => l.deliveryId)))];

  const multi = redis
    .multi()
    .geoadd(LocationKeys.geo, latest.lng, latest.lat, riderId)
    .hset(LocationKeys.last(riderId), {
      lat: latest.lat,
      lng: latest.lng,
      heading: latest.heading ?? '',
      speed: latest.speedMps ?? '',
      accuracy: latest.accuracyM ?? '',
      at: latest.at,
    })
    .expire(LocationKeys.last(riderId), LAST_SEEN_TTL_SECONDS)
    .sadd(LocationKeys.dirty, riderId)
    .incr(LocationKeys.seq(riderId));
  // Off-job pings only move the live position; breadcrumbs belong to a delivery.
  const crumbs: string[] = deliveryIds.flatMap((deliveryId) =>
    fresh.map((p) =>
      JSON.stringify({
        id: randomUUID(),
        deliveryId,
        riderId,
        lat: p.lat,
        lng: p.lng,
        accuracyM: p.accuracyM,
        speedMps: p.speedMps,
        heading: p.heading,
        recordedAt: p.recordedAt,
      } satisfies Breadcrumb),
    ),
  );
  if (crumbs.length) multi.rpush(LocationKeys.crumbs, ...crumbs);
  const results = await multi.exec();
  const seqResult = results?.[4];
  if (!seqResult || seqResult[0])
    throw new AppError('SERVICE_UNAVAILABLE', 'Location store failed');
  const version = Number(seqResult[1]);

  const nearbyOrderIds: string[] = [];
  for (const o of orders) {
    const dropoff =
      o.dropoffLat !== null && o.dropoffLng !== null
        ? { lat: o.dropoffLat, lng: o.dropoffLng }
        : null;
    const etaSeconds =
      dropoff && EN_ROUTE.includes(o.status) ? driveSeconds(latest, dropoff) : null;
    const payload: SocketEventPayload<typeof SocketEvent.RIDER_LOCATION> = {
      eventId: randomUUID(),
      id: riderId,
      version,
      occurredAt: new Date(latest.at).toISOString(),
      data: {
        lat: latest.lat,
        lng: latest.lng,
        orderId: o.id,
        heading: latest.heading,
        etaSeconds,
      },
    };
    deps.io?.to(Rooms.order(o.id)).emit(SocketEvent.RIDER_LOCATION, payload);

    if (o.status === 'on_the_way' && etaSeconds !== null && etaSeconds <= NEARBY_ETA_SECONDS) {
      try {
        await db.$transaction((tx) =>
          transitionOrder(tx, {
            orderId: o.id,
            to: 'rider_nearby',
            actor: 'system',
            actorUserId: null,
            expectedVersion: o.version,
            reason: 'gps',
          }),
        );
        nearbyOrderIds.push(o.id);
      } catch (err) {
        // Rider (or a parallel ping) moved the order first; the next ping re-checks.
        if (
          err instanceof AppError &&
          (err.code === 'CONFLICT' || err.code === 'INVALID_TRANSITION')
        )
          continue;
        deps.log.warn({ err, orderId: o.id }, 'rider nearby transition failed');
      }
    }
  }
  return { accepted: fresh.length, nearbyOrderIds };
}

/** Latest known position from Redis, or null when the rider hasn't pinged recently. */
export async function lastSeen(
  redis: RedisClient,
  riderId: string,
): Promise<{ lat: number; lng: number; heading: number | null; at: Date } | null> {
  const h = await redis.hgetall(LocationKeys.last(riderId));
  if (!h.lat || !h.lng || !h.at) return null;
  return {
    lat: Number(h.lat),
    lng: Number(h.lng),
    heading: h.heading ? Number(h.heading) : null,
    at: new Date(Number(h.at)),
  };
}
