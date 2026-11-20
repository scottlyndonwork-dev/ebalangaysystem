import { SocketEvent, type WeatherReading, type WeatherSurgeEvent } from '@ebalangay/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HELMET_SELFIE, monitorSafety } from '../src/modules/riders/safety.js';
import { LocationKeys } from '../src/modules/tracking/location.js';
import { MemoryWeatherFeed } from '../src/modules/weather/feed.js';
import {
  WEATHER_EVENT_TTL_MS,
  WeatherReason,
  watchWeather,
  weatherMatches,
} from '../src/modules/weather/watcher.js';
import { bearer, fixtures } from './fixtures.js';
import { buildTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
let ctx: Ctx;
const db = () => ctx.app.db;
const api = () => request(ctx.app.server);
const fx = fixtures(() => ctx);
const ADMIN_IP = '10.8.8.8';
const MIN = 60_000;
const ago = (m: number) => new Date(Date.now() - m * MIN);

beforeAll(async () => {
  ctx = await buildTestApp();
  await fx.zone();
});
afterAll(async () => {
  await ctx.close();
});

const events = (aggregateId: string, event?: string) =>
  db().outboxEvent.findMany({
    where: { aggregateId, ...(event ? { event } : {}) },
    orderBy: { createdAt: 'asc' },
  });
const monitor = () => monitorSafety({ db: db(), redis: ctx.app.redis });

async function shift(minutesAgo: number, status: 'online' | 'on_delivery' = 'online') {
  const r = await fx.rider();
  await db().rider.update({ where: { id: r.riderId }, data: { status } });
  const s = await db().riderShift.create({
    data: { riderId: r.riderId, startedAt: ago(minutesAgo) },
  });
  return { ...r, shiftId: s.id };
}

describe('safety monitor: helmet selfie', () => {
  it('reminds once per shift after 15 min without a passed selfie', async () => {
    const early = await shift(5);
    const due = await shift(20);
    const checked = await shift(20);
    await db().safetyCheck.create({
      data: {
        riderId: checked.riderId,
        shiftId: checked.shiftId,
        type: HELMET_SELFIE,
        passed: true,
      },
    });
    const failed = await shift(20);
    await db().safetyCheck.create({
      data: {
        riderId: failed.riderId,
        shiftId: failed.shiftId,
        type: HELMET_SELFIE,
        passed: false,
      },
    });

    await monitor();
    await monitor();

    const sent = await events(due.shiftId, SocketEvent.RIDER_SAFETY);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.rooms).toEqual([`rider:${due.riderId}`]);
    expect(sent[0]?.payload).toMatchObject({ version: 0, data: { kind: 'helmet_reminder' } });
    expect(sent[0]?.push).toMatchObject({
      userIds: [due.userId],
      app: 'rider',
      category: 'system',
      titleKey: 'notifications:helmetSelfieReminder.title',
      params: { minutes: 10 },
    });
    expect(await events(failed.shiftId)).toHaveLength(1);
    expect(await events(early.shiftId)).toHaveLength(0);
    expect(await events(checked.shiftId)).toHaveLength(0);
  });

  it('sets an online rider offline after 30 min, ends the shift and audit-logs it', async () => {
    const s = await shift(35);
    await monitor();

    const rider = await db().rider.findUniqueOrThrow({ where: { id: s.riderId } });
    expect(rider.status).toBe('offline');
    const ended = await db().riderShift.findUniqueOrThrow({ where: { id: s.shiftId } });
    expect(ended.endedAt).not.toBeNull();
    expect(ended.onlineSeconds).toBeGreaterThanOrEqual(35 * 60);
    const audit = await db().auditLog.findFirst({
      where: { action: 'rider.safety.auto_offline', targetId: s.riderId },
    });
    expect(audit).toMatchObject({ actorRole: 'system' });
    const sent = await events(s.shiftId, SocketEvent.RIDER_SAFETY);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ version: 1, data: { kind: 'auto_offline' } });
    expect(sent[0]?.rooms).toEqual([`rider:${s.riderId}`, 'admin']);

    await monitor();
    expect(await events(s.shiftId)).toHaveLength(1);
  });

  it('keeps a rider on a delivery online (reminded instead)', async () => {
    const s = await shift(35, 'on_delivery');
    await monitor();
    const rider = await db().rider.findUniqueOrThrow({ where: { id: s.riderId } });
    expect(rider.status).toBe('on_delivery');
    const sent = await events(s.shiftId);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ data: { kind: 'helmet_reminder' } });
  });
});

describe('safety monitor: GPS', () => {
  async function delivery(assignedMinutesAgo: number) {
    const r = await fx.rider();
    const d = await db().delivery.create({
      data: { riderId: r.riderId, status: 'picked_up', assignedAt: ago(assignedMinutesAgo) },
    });
    return { ...r, deliveryId: d.id };
  }
  const ping = (riderId: string, at: Date) =>
    ctx.app.redis.hset(LocationKeys.last(riderId), { lat: 8.9, lng: 125.5, at: at.getTime() });

  it('alerts the admin room once when an active delivery has no GPS for 10 min', async () => {
    const never = await delivery(15);
    const stale = await delivery(30);
    await ping(stale.riderId, ago(12));
    const live = await delivery(30);
    await ping(live.riderId, ago(1));
    const fresh = await delivery(3);

    await monitor();
    await monitor();

    const a = await events(never.deliveryId, SocketEvent.ADMIN_RIDER_ALERT);
    expect(a).toHaveLength(1);
    expect(a[0]?.rooms).toEqual(['admin']);
    expect(a[0]?.payload).toMatchObject({
      data: { riderId: never.riderId, kind: 'no_gps', lastSeenAt: null, minutes: 15 },
    });
    const b = await events(stale.deliveryId);
    expect(b).toHaveLength(1);
    expect(b[0]?.payload).toMatchObject({ data: { minutes: 12 } });
    expect(await events(live.deliveryId)).toHaveLength(0);
    expect(await events(fresh.deliveryId)).toHaveLength(0);
  });
});

describe('weather', () => {
  const feed = new MemoryWeatherFeed();
  let zoneId: string;
  let ruleId: string;
  const reading = (rainfall: WeatherReading['rainfall'], cycloneSignal = 0): WeatherReading => ({
    zoneId,
    rainfall,
    cycloneSignal,
    observedAt: new Date().toISOString(),
  });
  const watch = (now = new Date()) => watchWeather({ db: db(), feed }, now);
  const feedEvents = () =>
    db().surgeEvent.findMany({ where: { ruleId, reason: WeatherReason.FEED } });
  const surgeOutbox = () => events(zoneId, SocketEvent.SURGE_UPDATED);

  beforeAll(async () => {
    const z = await fx.zone();
    zoneId = z.id;
    const rule = await db().surgeRule.create({
      data: {
        zoneId,
        name: 'Heavy rain',
        multiplierBps: 15_000,
        trigger: 'weather',
        conditions: { minRainfall: 'orange', minCycloneSignal: 2 },
      },
    });
    ruleId = rule.id;
  });

  it('matches rainfall or cyclone thresholds; bad conditions never match', () => {
    const c = { minRainfall: 'orange', minCycloneSignal: 2 };
    expect(weatherMatches(c, reading('yellow', 1))).toBe(false);
    expect(weatherMatches(c, reading('orange'))).toBe(true);
    expect(weatherMatches(c, reading('red'))).toBe(true);
    expect(weatherMatches(c, reading('none', 2))).toBe(true);
    expect(weatherMatches({}, reading('red', 5))).toBe(false);
    expect(weatherMatches({ minRainfall: 'purple' }, reading('red'))).toBe(false);
  });

  it('feed: starts, extends and ends a surge; silence and no data leave it alone', async () => {
    feed.readings = null;
    expect(await watch()).toMatchObject({ skipped: true });

    feed.readings = [reading('orange')];
    const t0 = new Date();
    await watch(t0);
    let open = await feedEvents();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ multiplierBps: 15_000 });
    expect(open[0]?.endsAt?.getTime()).toBe(t0.getTime() + WEATHER_EVENT_TTL_MS);
    const surge = await surgeOutbox();
    expect(surge).toHaveLength(1);
    expect(surge[0]?.rooms).toEqual([`zone:${zoneId}`]);
    expect(surge[0]?.payload).toMatchObject({ data: { surgeBps: 15_000 } });

    // Still raining: same event, pushed out; no new hint.
    const t1 = new Date(t0.getTime() + 15 * MIN);
    await watch(t1);
    open = await feedEvents();
    expect(open).toHaveLength(1);
    expect(open[0]?.endsAt?.getTime()).toBe(t1.getTime() + WEATHER_EVENT_TTL_MS);
    expect(await surgeOutbox()).toHaveLength(1);

    // Feed silent about the zone: untouched.
    feed.readings = [];
    await watch(new Date(t1.getTime() + MIN));
    expect((await feedEvents())[0]?.endsAt?.getTime()).toBe(t1.getTime() + WEATHER_EVENT_TTL_MS);

    // Clear: ended now.
    feed.readings = [reading('none')];
    const t2 = new Date(t1.getTime() + 2 * MIN);
    await watch(t2);
    expect((await feedEvents())[0]?.endsAt?.getTime()).toBe(t2.getTime());
    const after = await surgeOutbox();
    expect(after).toHaveLength(2);
    expect(after[1]?.payload).toMatchObject({ data: { surgeBps: 10_000 } });
  });

  it('ignores stale readings', async () => {
    feed.readings = [{ ...reading('red'), observedAt: ago(90).toISOString() }];
    const before = (await feedEvents()).length;
    await watch();
    expect(await feedEvents()).toHaveLength(before);
  });

  describe('admin trigger', () => {
    const post = (path: string, token: string | null, body?: object) => {
      const req = api().post(`/v1/admin/weather${path}`).set('x-forwarded-for', ADMIN_IP);
      if (token) void req.set(bearer(token));
      return body ? req.send(body) : req;
    };
    let admin: string;
    beforeAll(async () => {
      const u = await fx.user(['admin']);
      admin = fx.tokenFor(u.id, ['admin'], 'admin-web');
    });

    it('is admin-only and validates the body', async () => {
      const body = { zoneId, multiplierBps: 13_000, durationMinutes: 60, note: 'Flooding' };
      await post('/trigger', null, body).expect(401);
      const customer = await fx.customer();
      await post('/trigger', customer.token, body).expect(403);
      await post('/trigger', admin, { ...body, ruleId }).expect(400);
      await post('/trigger', admin, { zoneId, durationMinutes: 60, note: 'x' }).expect(400);
      await post('/trigger', admin, { ...body, durationMinutes: 5 }).expect(400);
    });

    it('declares a surge, audit-logs it, hints the zone; end is idempotent', async () => {
      const res = await post('/trigger', admin, {
        zoneId,
        ruleId,
        durationMinutes: 90,
        note: 'Signal 2 announced',
      }).expect(201);
      const e = res.body as WeatherSurgeEvent;
      expect(e).toMatchObject({
        zoneId,
        ruleId,
        multiplierBps: 15_000,
        reason: WeatherReason.MANUAL,
        zoneSurgeBps: 15_000,
      });
      expect(new Date(e.endsAt as string).getTime() - new Date(e.startsAt).getTime()).toBe(
        90 * MIN,
      );
      const audit = await db().auditLog.findFirst({
        where: { action: 'weather.surge.trigger', targetId: e.id },
      });
      expect(audit?.metadata).toMatchObject({ note: 'Signal 2 announced', durationMinutes: 90 });
      const hints = await surgeOutbox();
      expect(hints.at(-1)?.payload).toMatchObject({ data: { surgeBps: 15_000 } });

      // The feed never ends a manual surge.
      feed.readings = [reading('none')];
      await watch();
      const still = await db().surgeEvent.findUniqueOrThrow({ where: { id: e.id } });
      expect(still.endsAt?.getTime()).toBe(new Date(e.endsAt as string).getTime());

      const ended = await post(`/events/${e.id}/end`, admin).expect(200);
      expect(ended.body).toMatchObject({ id: e.id, zoneSurgeBps: 10_000 });
      const again = await post(`/events/${e.id}/end`, admin).expect(200);
      expect((again.body as WeatherSurgeEvent).endsAt).toBe(
        (ended.body as WeatherSurgeEvent).endsAt,
      );
      expect(
        await db().auditLog.count({ where: { action: 'weather.surge.end', targetId: e.id } }),
      ).toBe(1);
    });

    it('404s for unknown zones, non-weather rules and non-weather events', async () => {
      const other = await db().surgeRule.create({
        data: { zoneId, name: 'Manual', multiplierBps: 12_000, trigger: 'manual' },
      });
      await post('/trigger', admin, {
        zoneId,
        ruleId: other.id,
        durationMinutes: 30,
        note: 'x',
      }).expect(404);
      await post('/trigger', admin, {
        zoneId: '00000000-0000-7000-8000-000000000000',
        multiplierBps: 12_000,
        durationMinutes: 30,
        note: 'x',
      }).expect(404);
      const plain = await db().surgeEvent.create({
        data: { zoneId, multiplierBps: 12_000, startsAt: new Date(), reason: 'concert' },
      });
      await post(`/events/${plain.id}/end`, admin).expect(404);
      await db().surgeRule.update({ where: { id: other.id }, data: { isActive: false } });
    });
  });
});
