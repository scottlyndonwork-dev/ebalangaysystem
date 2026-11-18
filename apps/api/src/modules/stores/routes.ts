import {
  cursorPageQuerySchema,
  cursorPageSchema,
  followStatusSchema,
  followedStoreSchema,
  myMerchantSchema,
  type StaffRolePreset,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { authOf, requireAuth } from '../../plugins/auth.js';

const params = z.object({ merchantId: z.uuid() });

/** Opaque cursor for (createdAt desc, merchantId desc) pages. */
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

/** /v1/stores/* — customer-facing store actions. Browse/search arrive in 2B-3. */
export async function storeRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['stores'];

  const followStatus = async (userId: string, merchantId: string) => {
    const [following, followerCount] = await Promise.all([
      app.db.follower.findUnique({ where: { userId_merchantId: { userId, merchantId } } }),
      app.db.follower.count({ where: { merchantId } }),
    ]);
    return { following: following !== null, followerCount };
  };

  const assertFollowable = async (merchantId: string) => {
    const m = await app.db.merchant.findUnique({
      where: { id: merchantId },
      select: { status: true },
    });
    if (m?.status !== 'active') throw new AppError('NOT_FOUND', 'Store not found');
  };

  r.put(
    '/:merchantId/follow',
    {
      schema: { tags, params, response: { 200: followStatusSchema } },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const { merchantId } = req.params;
      await assertFollowable(merchantId);
      // Idempotent: following twice is fine.
      await app.db.follower.upsert({
        where: { userId_merchantId: { userId, merchantId } },
        create: { userId, merchantId },
        update: {},
      });
      return followStatus(userId, merchantId);
    },
  );

  r.delete(
    '/:merchantId/follow',
    {
      schema: { tags, params, response: { 200: followStatusSchema } },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const { merchantId } = req.params;
      await app.db.follower.deleteMany({ where: { userId, merchantId } });
      return followStatus(userId, merchantId);
    },
  );
}

/** /v1/me/merchants and /v1/me/following. */
export async function meStoreRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['me'];

  /** Store picker in the merchant app: every store the caller is active staff of. */
  r.get(
    '/merchants',
    {
      schema: { tags, response: { 200: z.object({ items: z.array(myMerchantSchema) }) } },
      preHandler: requireAuth,
    },
    async (req) => {
      const rows = await app.db.merchantStaff.findMany({
        where: { userId: authOf(req).userId, isActive: true },
        include: {
          merchant: { select: { id: true, slug: true, name: true, status: true, logoUrl: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
      return {
        items: rows.map((s) => ({ ...s.merchant, rolePreset: s.rolePreset as StaffRolePreset })),
      };
    },
  );

  r.get(
    '/following',
    {
      schema: {
        tags,
        querystring: cursorPageQuerySchema,
        response: { 200: cursorPageSchema(followedStoreSchema) },
      },
      preHandler: requireAuth,
    },
    async (req) => {
      const userId = authOf(req).userId;
      const { cursor, limit } = req.query;
      const c = cursor ? decodeCursor(cursor) : null;
      const rows = await app.db.follower.findMany({
        where: {
          userId,
          merchant: { status: 'active' },
          ...(c
            ? {
                OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, merchantId: { lt: c.id } }],
              }
            : {}),
        },
        include: { merchant: { select: { slug: true, name: true, logoUrl: true } } },
        orderBy: [{ createdAt: 'desc' }, { merchantId: 'desc' }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((f) => ({
          merchantId: f.merchantId,
          slug: f.merchant.slug,
          name: f.merchant.name,
          logoUrl: f.merchant.logoUrl,
          followedAt: f.createdAt.toISOString(),
        })),
        nextCursor:
          rows.length > limit && last ? encodeCursor(last.createdAt, last.merchantId) : null,
      };
    },
  );
}
