import {
  merchantPermissionSchema,
  merchantStaffSchema,
  merchantStatusSchema,
  type MerchantPermission,
  type StaffRolePreset,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withMerchantContext } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { merchantAccessOf, requireMerchantPermission } from '../../plugins/auth.js';

const tags = ['merchant'];
const params = z.object({ merchantId: z.uuid() });

/** What the merchant app needs to render its navigation for this store. */
const merchantAccessSchema = z.object({
  merchant: z.object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    status: merchantStatusSchema,
  }),
  isOwner: z.boolean(),
  permissions: z.array(merchantPermissionSchema),
});

/**
 * /v1/merchants/:merchantId/* — merchant-app and merchant-web only. Two layers:
 * 1. requireMerchantPermission: the caller is active staff of THIS merchant, with the permission.
 * 2. withMerchantContext: Postgres RLS hides every other merchant's rows in the transaction.
 */
export async function merchantRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/:merchantId/access',
    {
      schema: { tags, params, response: { 200: merchantAccessSchema } },
      preHandler: requireMerchantPermission(),
    },
    async (req) => {
      const access = merchantAccessOf(req);
      const merchant = await withMerchantContext(app.db, access.merchantId, (tx) =>
        tx.merchant.findUnique({
          where: { id: access.merchantId },
          select: { id: true, slug: true, name: true, status: true },
        }),
      );
      if (!merchant) throw new AppError('NOT_FOUND', 'Store not found');
      return {
        merchant,
        isOwner: access.isOwner,
        permissions: [...access.permissions],
      };
    },
  );

  r.get(
    '/:merchantId/staff',
    {
      schema: {
        tags,
        params,
        response: { 200: z.object({ items: z.array(merchantStaffSchema) }) },
      },
      preHandler: requireMerchantPermission('staff.manage'),
    },
    async (req) => {
      const rows = await withMerchantContext(app.db, req.params.merchantId, (tx) =>
        tx.merchantStaff.findMany({ orderBy: { createdAt: 'asc' } }),
      );
      return {
        items: rows.map((s) => ({
          id: s.id,
          merchantId: s.merchantId,
          userId: s.userId,
          displayName: s.displayName,
          rolePreset: s.rolePreset as StaffRolePreset,
          permissions: s.permissions as MerchantPermission[],
          isActive: s.isActive,
          createdAt: s.createdAt.toISOString(),
        })),
      };
    },
  );
}
