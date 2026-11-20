import { cursorPageQuerySchema, cursorPageSchema } from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { requireAdmin } from '../../plugins/auth.js';
import { adminMerchantRoutes } from './merchants.js';
import { adminWeatherRoutes } from './weather.js';

const tags = ['admin'];

const auditLogSchema = z.object({
  id: z.uuid(),
  action: z.string(),
  actorUserId: z.uuid().nullable(),
  actorRole: z.string().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  merchantId: z.uuid().nullable(),
  ip: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime({ offset: true }),
});

/** /v1/admin/* — every route: allowlisted IP, admin role, admin-web session (TOTP). */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', requireAdmin());

  r.get(
    '/audit-logs',
    {
      schema: {
        tags,
        querystring: cursorPageQuerySchema.extend({
          cursor: z.uuid().optional(),
          action: z.string().max(100).optional(),
          merchantId: z.uuid().optional(),
        }),
        response: { 200: cursorPageSchema(auditLogSchema) },
      },
    },
    async (req) => {
      const { cursor, limit, action, merchantId } = req.query;
      // Ids are UUIDv7 (time-ordered), so the id doubles as a stable cursor.
      const rows = await app.db.auditLog.findMany({
        where: {
          ...(action ? { action } : {}),
          ...(merchantId ? { merchantId } : {}),
          ...(cursor ? { id: { lt: cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      return {
        items: page.map((a) => ({
          ...a,
          metadata: (a.metadata ?? {}) as Record<string, unknown>,
          createdAt: a.createdAt.toISOString(),
        })),
        nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );

  await app.register(adminMerchantRoutes);
  await app.register(adminWeatherRoutes);
}
