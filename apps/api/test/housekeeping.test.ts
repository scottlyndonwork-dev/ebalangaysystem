import { SocketEvent } from '@ebalangay/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refreshAnalyticsViews } from '../src/modules/analytics/refresh.js';
import {
  cachedSchedules,
  MENU_BOUNDARY_CURSOR_KEY,
  menuBoundaryTick,
  menuCacheKey,
} from '../src/modules/catalog/menu-cache.js';
import { evaluateVerifiedBadges } from '../src/modules/merchants/verified-badge.js';
import { expirePoints } from '../src/modules/points/expiry.js';
import { expireStories } from '../src/modules/stories/expiry.js';
import { bearer, fixtures } from './fixtures.js';
import { buildTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
let ctx: Ctx;
const api = () => request(ctx.app.server);
const db = () => ctx.app.db;
const fx = fixtures(() => ctx);
type Store = Awaited<ReturnType<typeof fx.store>>;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
let store: Store;

beforeAll(async () => {
  ctx = await buildTestApp();
  await fx.zone();
  store = await fx.store();
});

afterAll(async () => {
  await ctx.app.redis.del(MENU_BOUNDARY_CURSOR_KEY);
  await ctx.close();
});

describe('stories expiry', () => {
  it('deletes expired stories and their media, keeps live ones', async () => {
    const story = async (key: string, expiresAt: Date) => {
      await ctx.storage.put('public', key, Buffer.from('x'), 'image/webp');
      return db().story.create({
        data: {
          merchantId: store.merchantId,
          mediaType: 'image',
          mediaUrl: ctx.storage.publicUrl(key),
          expiresAt,
        },
      });
    };
    const old = await story(`stories/${store.merchantId}/old.webp`, new Date(Date.now() - MIN));
    const live = await story(`stories/${store.merchantId}/live.webp`, new Date(Date.now() + DAY));

    const r = await expireStories({ db: db(), storage: ctx.storage });
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(await db().story.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db().story.findUnique({ where: { id: live.id } })).not.toBeNull();
    expect(ctx.storage.objects.has(`public/stories/${store.merchantId}/old.webp`)).toBe(false);
    expect(ctx.storage.objects.has(`public/stories/${store.merchantId}/live.webp`)).toBe(true);
  });
});

describe('points expiry', () => {
  it('expires what is left of old credits (FIFO) once', async () => {
    const c = await fx.customer();
    const account = await db().pointsAccount.create({
      data: { userId: c.userId, balance: 100, lifetimeEarned: 110 },
    });
    const now = new Date();
    await db().pointsTransaction.createMany({
      data: [
        // 60 old points, 10 of them redeemed (oldest first) → 50 expire.
        {
          accountId: account.id,
          type: 'earn',
          points: 60,
          balanceAfter: 60,
          description: 'old',
          expiresAt: new Date(now.getTime() - DAY),
          createdAt: new Date(now.getTime() - 400 * DAY),
        },
        {
          accountId: account.id,
          type: 'redeem',
          points: -10,
          balanceAfter: 50,
          description: 'redeem',
          createdAt: new Date(now.getTime() - 300 * DAY),
        },
        {
          accountId: account.id,
          type: 'earn',
          points: 50,
          balanceAfter: 100,
          description: 'fresh',
          expiresAt: new Date(now.getTime() + 100 * DAY),
          createdAt: new Date(now.getTime() - 10 * DAY),
        },
      ],
    });

    await expirePoints(db(), now);
    const after = await db().pointsAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.balance).toBe(50);
    const expired = await db().pointsTransaction.findMany({
      where: { accountId: account.id, type: 'expire' },
    });
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ points: -50, balanceAfter: 50 });

    await expirePoints(db(), now);
    expect(
      await db().pointsTransaction.count({ where: { accountId: account.id, type: 'expire' } }),
    ).toBe(1);
  });
});

describe('analytics refresh', () => {
  it('refreshes the materialized views concurrently', async () => {
    const r = await refreshAnalyticsViews(db());
    expect(r.views).toContain('mv_merchant_daily_sales');
  });
});

describe('verified badge', () => {
  it('revokes the badge from a merchant without the track record, audited and notified', async () => {
    const s = await fx.store({ verified: true });
    const r = await evaluateVerifiedBadges({ db: db() });
    expect(r.revoked).toBeGreaterThanOrEqual(1);

    const m = await db().merchant.findUniqueOrThrow({ where: { id: s.merchantId } });
    expect(m.verifiedBadge).toBe(false);
    expect(m.version).toBe(s.merchant.version + 1);
    const audit = await db().auditLog.findFirst({
      where: { targetId: s.merchantId, action: 'merchant.verified_badge.revoke' },
    });
    expect(audit?.actorRole).toBe('system');
    expect(audit?.metadata).toMatchObject({
      delivered: 0,
      failed: expect.arrayContaining(['min_delivered']),
    });
    const event = await db().outboxEvent.findFirst({
      where: { aggregateId: s.merchantId, event: SocketEvent.MERCHANT_BADGE_UPDATED },
    });
    expect(event?.rooms).toEqual([`merchant:${s.merchantId}`]);
    expect(event?.push).toMatchObject({
      titleKey: 'notifications:verifiedBadgeRevoked.title',
      userIds: expect.arrayContaining([s.ownerId]),
      app: 'merchant',
    });

    // Rerun: nothing left to change for this merchant.
    await evaluateVerifiedBadges({ db: db() });
    expect(
      await db().auditLog.count({
        where: { targetId: s.merchantId, action: { startsWith: 'merchant.verified_badge' } },
      }),
    ).toBe(1);
  });
});

describe('menu schedule cache', () => {
  it('reads through Redis and is invalidated by schedule writes', async () => {
    const redis = ctx.app.redis;
    await redis.del(menuCacheKey(store.merchantId));
    const res = await api()
      .post(`${store.base}/menu-schedules`)
      .set(bearer(store.owner))
      .send({ name: 'Breakfast', dayOfWeek: 1, startTime: '06:00', endTime: '10:00' })
      .expect(201);
    const scheduleId = (res.body as { id: string }).id;

    const first = await cachedSchedules(db(), redis, [store.merchantId]);
    expect(first(store.merchantId).map((s) => s.id)).toContain(scheduleId);
    expect(await redis.get(menuCacheKey(store.merchantId))).toContain(scheduleId);

    // A hit doesn't touch Postgres: a row written behind the cache's back stays invisible.
    await db().menuSchedule.update({ where: { id: scheduleId }, data: { isActive: false } });
    const hit = await cachedSchedules(db(), redis, [store.merchantId]);
    expect(hit(store.merchantId).map((s) => s.id)).toContain(scheduleId);

    await api()
      .put(`${store.base}/menu-schedules/${scheduleId}`)
      .set(bearer(store.owner))
      .send({ name: 'Breakfast', dayOfWeek: 1, startTime: '06:00', endTime: '10:00' })
      .expect(200);
    expect(await redis.get(menuCacheKey(store.merchantId))).toBeNull();

    await api()
      .delete(`${store.base}/menu-schedules/${scheduleId}`)
      .set(bearer(store.owner))
      .expect(204);
    const fresh = await cachedSchedules(db(), redis, [store.merchantId]);
    expect(fresh(store.merchantId).map((s) => s.id)).not.toContain(scheduleId);
  });

  it('announces windows opening and closing at the minute, once', async () => {
    const s = await fx.store();
    // Monday 2030-01-07 10:30 Manila.
    const at = new Date('2030-01-07T02:30:00Z');
    const minute = at.getTime() / MIN;
    const [opens, closes] = await Promise.all([
      db().menuSchedule.create({
        data: {
          merchantId: s.merchantId,
          name: 'Lunch',
          dayOfWeek: 1,
          startTime: '10:30',
          endTime: '14:00',
        },
      }),
      // Sunday 22:00 → Monday 10:30.
      db().menuSchedule.create({
        data: {
          merchantId: s.merchantId,
          name: 'Late night',
          dayOfWeek: 0,
          startTime: '22:00',
          endTime: '10:30',
        },
      }),
    ]);
    const redis = ctx.app.redis;
    await redis.set(menuCacheKey(s.merchantId), '[]');
    await redis.set(MENU_BOUNDARY_CURSOR_KEY, String(minute - 1));

    const r = await menuBoundaryTick({ db: db(), redis }, new Date(at.getTime() + 20_000));
    expect(r.minutes).toBe(1);
    const events = await db().outboxEvent.findMany({
      where: { aggregateId: s.merchantId, event: SocketEvent.MERCHANT_MENU_CHANGED },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.version).toBe(minute);
    expect(events[0]?.rooms).toEqual([`merchant:${s.merchantId}`]);
    const changes = (events[0]?.payload as { data: { changes: unknown[] } }).data.changes;
    expect(changes).toEqual(
      expect.arrayContaining([
        { scheduleId: opens.id, kind: 'start' },
        { scheduleId: closes.id, kind: 'end' },
      ]),
    );
    expect(await redis.get(menuCacheKey(s.merchantId))).toBeNull();

    // Same minute again: the cursor already covers it.
    const again = await menuBoundaryTick({ db: db(), redis }, new Date(at.getTime() + 40_000));
    expect(again.minutes).toBe(0);
    expect(
      await db().outboxEvent.count({
        where: { aggregateId: s.merchantId, event: SocketEvent.MERCHANT_MENU_CHANGED },
      }),
    ).toBe(1);
  });
});
