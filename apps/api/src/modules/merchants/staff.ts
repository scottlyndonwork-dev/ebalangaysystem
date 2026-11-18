import {
  ALL_MERCHANT_PERMISSIONS,
  STAFF_ROLE_PRESETS,
  inviteStaffInputSchema,
  merchantStaffSchema,
  updateStaffInputSchema,
  type MerchantPermission,
  type MerchantStaff,
  type StaffRolePreset,
} from '@ebalangay/shared';
import { getServerT } from '@ebalangay/i18n/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type Tx, withMerchantContext } from '../../db.js';
import type { MerchantStaff as StaffRow } from '../../generated/prisma/client.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { merchantAccessOf, requireMerchantPermission } from '../../plugins/auth.js';

const tags = ['merchant-staff'];
const params = z.object({ merchantId: z.uuid() });
const staffParams = params.extend({ staffId: z.uuid() });

type StaffWithPhone = StaffRow & { user: { phone: string | null } };

function toStaff(s: StaffWithPhone): MerchantStaff {
  return {
    id: s.id,
    merchantId: s.merchantId,
    userId: s.userId,
    displayName: s.displayName,
    rolePreset: s.rolePreset as StaffRolePreset,
    permissions: (s.rolePreset === 'owner'
      ? ALL_MERCHANT_PERMISSIONS
      : s.permissions) as MerchantPermission[],
    isActive: s.isActive,
    phone: s.user.phone,
    createdAt: s.createdAt.toISOString(),
  };
}

/**
 * Anti-escalation: a non-owner may only hand out permissions they hold themselves, and only
 * owners can create, change or remove owners.
 */
function assertCanGrant(
  req: FastifyRequest,
  rolePreset: StaffRolePreset,
  permissions: readonly MerchantPermission[],
): void {
  const access = merchantAccessOf(req);
  if (access.isOwner) return;
  if (rolePreset === 'owner') throw new AppError('FORBIDDEN', 'Only owners can add owners');
  const extra = permissions.filter((p) => !access.permissions.includes(p));
  if (extra.length) {
    throw new AppError('FORBIDDEN', 'You cannot grant permissions you do not have', { extra });
  }
}

async function activeOwnerCount(tx: Tx, merchantId: string): Promise<number> {
  return tx.merchantStaff.count({ where: { merchantId, rolePreset: 'owner', isActive: true } });
}

export async function staffRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

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
        tx.merchantStaff.findMany({
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { phone: true } } },
        }),
      );
      return { items: rows.map(toStaff) };
    },
  );

  r.post(
    '/:merchantId/staff',
    {
      schema: {
        tags,
        params,
        body: inviteStaffInputSchema,
        response: { 201: merchantStaffSchema },
      },
      preHandler: requireMerchantPermission('staff.manage'),
    },
    async (req, reply) => {
      const { merchantId } = req.params;
      const { phone, displayName, rolePreset } = req.body;
      const permissions = req.body.permissions ?? [...STAFF_ROLE_PRESETS[rolePreset]];
      assertCanGrant(req, rolePreset, permissions);
      const role = rolePreset === 'owner' ? 'merchant_owner' : 'merchant_staff';

      const { staff, store, locale } = await withMerchantContext(app.db, merchantId, async (tx) => {
        let user = await tx.user.findUnique({
          where: { phone },
          select: { id: true, roles: true, status: true, locale: true },
        });
        if (user && user.status !== 'active') {
          throw new AppError('CONFLICT', 'This number cannot be added');
        }
        if (!user) {
          // Minimal account; the person finishes their profile at first OTP sign-in.
          user = await tx.user.create({
            data: { phone, roles: [role] },
            select: { id: true, roles: true, status: true, locale: true },
          });
        } else if (!user.roles.includes(role)) {
          await tx.user.update({ where: { id: user.id }, data: { roles: { push: role } } });
        }
        if (
          await tx.merchantStaff.findUnique({
            where: { merchantId_userId: { merchantId, userId: user.id } },
          })
        ) {
          throw new AppError('CONFLICT', 'This person is already on your team');
        }
        const created = await tx.merchantStaff.create({
          data: {
            merchantId,
            userId: user.id,
            displayName,
            rolePreset,
            permissions: rolePreset === 'owner' ? [...ALL_MERCHANT_PERMISSIONS] : permissions,
          },
          include: { user: { select: { phone: true } } },
        });
        await writeAudit(tx, req, {
          action: 'merchant.staff.invite',
          targetType: 'merchant_staff',
          targetId: created.id,
          merchantId,
          metadata: { rolePreset, permissions: created.permissions },
        });
        const m = await tx.merchant.findUniqueOrThrow({
          where: { id: merchantId },
          select: { name: true },
        });
        return { staff: created, store: m.name, locale: user.locale };
      });

      // After commit; a failed SMS must not undo the invite (the owner can tell them directly).
      try {
        await app.sms.send(phone, getServerT(locale)('notifications:staffInvite.sms', { store }));
      } catch (err) {
        req.log.warn({ err }, 'staff invite sms failed');
      }
      return reply.status(201).send(toStaff(staff));
    },
  );

  r.patch(
    '/:merchantId/staff/:staffId',
    {
      schema: {
        tags,
        params: staffParams,
        body: updateStaffInputSchema,
        response: { 200: merchantStaffSchema },
      },
      preHandler: requireMerchantPermission('staff.manage'),
    },
    async (req) => {
      const { merchantId, staffId } = req.params;
      const body = req.body;
      const access = merchantAccessOf(req);

      const updated = await withMerchantContext(app.db, merchantId, async (tx) => {
        const target = await tx.merchantStaff.findFirst({ where: { id: staffId, merchantId } });
        if (!target) throw new AppError('NOT_FOUND', 'Staff member not found');
        const changesAccess =
          body.rolePreset !== undefined ||
          body.permissions !== undefined ||
          body.isActive !== undefined;
        if (changesAccess && target.id === access.staffId) {
          throw new AppError('FORBIDDEN', 'Ask another manager to change your own access');
        }
        if (target.rolePreset === 'owner' && !access.isOwner) {
          throw new AppError('FORBIDDEN', 'Only owners can change owners');
        }

        const rolePreset = (body.rolePreset ?? target.rolePreset) as StaffRolePreset;
        const permissions =
          body.permissions ??
          (body.rolePreset !== undefined
            ? [...STAFF_ROLE_PRESETS[rolePreset]]
            : (target.permissions as MerchantPermission[]));
        if (changesAccess) assertCanGrant(req, rolePreset, permissions);

        const row = await tx.merchantStaff.update({
          where: { id: staffId },
          data: {
            ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
            ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
            rolePreset,
            permissions: rolePreset === 'owner' ? [...ALL_MERCHANT_PERMISSIONS] : permissions,
          },
          include: { user: { select: { phone: true } } },
        });
        // Checked after the write, inside the transaction: never leave a store without an owner.
        if (target.rolePreset === 'owner' && (await activeOwnerCount(tx, merchantId)) === 0) {
          throw new AppError('CONFLICT', 'A store needs at least one active owner');
        }
        await writeAudit(tx, req, {
          action: 'merchant.staff.update',
          targetType: 'merchant_staff',
          targetId: staffId,
          merchantId,
          metadata: {
            fields: Object.keys(body),
            rolePreset,
            permissions: row.permissions,
          },
        });
        return row;
      });
      return toStaff(updated);
    },
  );

  r.delete(
    '/:merchantId/staff/:staffId',
    {
      schema: { tags, params: staffParams },
      preHandler: requireMerchantPermission('staff.manage'),
    },
    async (req, reply) => {
      const { merchantId, staffId } = req.params;
      const access = merchantAccessOf(req);
      await withMerchantContext(app.db, merchantId, async (tx) => {
        const target = await tx.merchantStaff.findFirst({ where: { id: staffId, merchantId } });
        if (!target) throw new AppError('NOT_FOUND', 'Staff member not found');
        if (target.id === access.staffId) {
          throw new AppError('FORBIDDEN', 'Ask another manager to remove you');
        }
        if (target.rolePreset === 'owner' && !access.isOwner) {
          throw new AppError('FORBIDDEN', 'Only owners can remove owners');
        }
        await tx.merchantStaff.delete({ where: { id: staffId } });
        if (target.rolePreset === 'owner' && (await activeOwnerCount(tx, merchantId)) === 0) {
          throw new AppError('CONFLICT', 'A store needs at least one active owner');
        }
        await writeAudit(tx, req, {
          action: 'merchant.staff.remove',
          targetType: 'merchant_staff',
          targetId: staffId,
          merchantId,
          metadata: { userId: target.userId, rolePreset: target.rolePreset },
        });
      });
      return reply.status(204).send();
    },
  );
}
