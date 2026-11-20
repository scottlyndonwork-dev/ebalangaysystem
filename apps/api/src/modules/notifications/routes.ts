import {
  cursorPageSchema,
  listNotificationsQuerySchema,
  markNotificationsReadInputSchema,
  markNotificationsReadResultSchema,
  NotificationType,
  notificationPreferencesSchema,
  notificationSchema,
  unreadNotificationsSchema,
  updateNotificationPreferencesInputSchema,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { authOf, requireAuth } from '../../plugins/auth.js';
import { toNotificationDto } from './service.js';

const tags = ['notifications'];

/** Opaque cursor for (createdAt desc, id desc) pages. */
const encodeCursor = (at: Date, id: string) =>
  Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
function decodeCursor(cursor: string): { at: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const at = new Date(iso ?? '');
  if (!id || Number.isNaN(at.getTime()) || !z.uuid().safeParse(id).success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid cursor');
  }
  return { at, id };
}

async function loadPreferences(db: Db, userId: string) {
  const rows = await db.notificationPreference.findMany({ where: { userId } });
  return {
    preferences: Object.values(NotificationType).map((category) => {
      const r = rows.find((x) => x.category === category);
      return { category, push: r?.push ?? true, sms: r?.sms ?? true, inApp: r?.inApp ?? true };
    }),
  };
}

/** /v1/me/notifications/* : the signed-in user's in-app inbox and channel preferences. */
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', requireAuth);

  r.get(
    '/',
    {
      schema: {
        tags,
        querystring: listNotificationsQuerySchema,
        response: { 200: cursorPageSchema(notificationSchema) },
      },
    },
    async (req) => {
      const userId = authOf(req).userId;
      const { cursor, limit, unreadOnly } = req.query;
      const c = cursor ? decodeCursor(cursor) : null;
      const where: Prisma.NotificationWhereInput = {
        userId,
        ...(unreadOnly ? { readAt: null } : {}),
        ...(c ? { OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }] } : {}),
      };
      const rows = await app.db.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toNotificationDto),
        nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },
  );

  r.get(
    '/unread-count',
    { schema: { tags, response: { 200: unreadNotificationsSchema } } },
    async (req) => ({
      count: await app.db.notification.count({
        where: { userId: authOf(req).userId, readAt: null },
      }),
    }),
  );

  r.post(
    '/read',
    {
      schema: {
        tags,
        body: markNotificationsReadInputSchema,
        response: { 200: markNotificationsReadResultSchema },
      },
    },
    async (req) => {
      const { ids, all } = req.body;
      if (!all && !ids?.length) {
        throw new AppError('VALIDATION_FAILED', 'Pass ids or all: true');
      }
      const { count } = await app.db.notification.updateMany({
        where: { userId: authOf(req).userId, readAt: null, ...(all ? {} : { id: { in: ids } }) },
        data: { readAt: new Date() },
      });
      return { updated: count };
    },
  );

  r.get(
    '/preferences',
    { schema: { tags, response: { 200: notificationPreferencesSchema } } },
    async (req) => loadPreferences(app.db, authOf(req).userId),
  );

  r.put(
    '/preferences',
    {
      schema: {
        tags,
        body: updateNotificationPreferencesInputSchema,
        response: { 200: notificationPreferencesSchema },
      },
    },
    async (req) => {
      const userId = authOf(req).userId;
      await app.db.$transaction(
        req.body.preferences.map(({ category, ...channels }) => {
          const set = Object.fromEntries(
            Object.entries(channels).filter(([, v]) => v !== undefined),
          ) as { push?: boolean; sms?: boolean; inApp?: boolean };
          return app.db.notificationPreference.upsert({
            where: { userId_category: { userId, category } },
            update: set,
            create: { userId, category, ...set },
          });
        }),
      );
      return loadPreferences(app.db, authOf(req).userId);
    },
  );
}
