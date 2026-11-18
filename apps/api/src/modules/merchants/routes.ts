import { randomBytes } from 'node:crypto';
import {
  ALL_MERCHANT_PERMISSIONS,
  INDEFINITE_PAUSE_UNTIL,
  createMerchantInputSchema,
  dateKeySchema,
  manilaDateKey,
  merchantPermissionSchema,
  merchantProfileSchema,
  merchantStatusSchema,
  pauseStoreInputSchema,
  presignedUploadSchema,
  requestImageUploadInputSchema,
  setWeeklyHoursInputSchema,
  storeHoursSchema,
  updateMerchantInputSchema,
  upsertHolidayInputSchema,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Tx, withMerchantContext } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { objectKey } from '../../lib/storage.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import {
  authOf,
  merchantAccessOf,
  requireAuth,
  requireMerchantPermission,
} from '../../plugins/auth.js';
import { documentRoutes } from './documents.js';
import { assignZone, dateOfKey, holidayOf, profileInclude, slugFor, toProfile } from './service.js';
import { staffRoutes } from './staff.js';

const tags = ['merchant'];
const params = z.object({ merchantId: z.uuid() });
const MAX_DRAFTS_PER_USER = 3;
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;

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

async function loadProfile(tx: Tx, merchantId: string) {
  const m = await tx.merchant.findUnique({ where: { id: merchantId }, include: profileInclude() });
  if (!m) throw new AppError('NOT_FOUND', 'Store not found');
  return toProfile(m);
}

/**
 * /v1/merchants/:merchantId/* — merchant-app and merchant-web only. Two layers:
 * 1. requireMerchantPermission: the caller is active staff of THIS merchant, with the permission.
 * 2. withMerchantContext: Postgres RLS hides every other merchant's rows in the transaction.
 */
export async function merchantRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ------------------------------------------------------------ onboarding: start application
  r.post(
    '/',
    {
      schema: { tags, body: createMerchantInputSchema, response: { 201: merchantProfileSchema } },
      preHandler: requireAuth,
    },
    async (req, reply) => {
      const auth = authOf(req);
      if (auth.app !== 'merchant' && auth.app !== 'merchant-web') {
        throw new AppError('FORBIDDEN', 'Use the merchant app');
      }
      const drafts = await app.db.merchantStaff.count({
        where: {
          userId: auth.userId,
          rolePreset: 'owner',
          merchant: { status: { in: ['draft', 'pending_review'] } },
        },
      });
      if (drafts >= MAX_DRAFTS_PER_USER) {
        throw new AppError('CONFLICT', 'Finish or withdraw your other store applications first');
      }
      const user = await app.db.user.findUnique({
        where: { id: auth.userId },
        select: { firstName: true, roles: true },
      });
      if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in required');

      const { location, ...input } = req.body;
      const merchantId = await app.db.$transaction(async (tx) => {
        const m = await tx.merchant.create({
          data: {
            ...input,
            slug: slugFor(input.name, randomBytes(3).toString('hex')),
            lat: location.lat,
            lng: location.lng,
            status: 'draft',
          },
        });
        await tx.merchantStaff.create({
          data: {
            merchantId: m.id,
            userId: auth.userId,
            displayName: user.firstName || 'Owner',
            rolePreset: 'owner',
            permissions: [...ALL_MERCHANT_PERMISSIONS],
          },
        });
        if (!user.roles.includes('merchant_owner')) {
          await tx.user.update({
            where: { id: auth.userId },
            data: { roles: { push: 'merchant_owner' } },
          });
        }
        await assignZone(tx, m.id);
        await writeAudit(tx, req, {
          action: 'merchant.application.create',
          targetType: 'merchant',
          targetId: m.id,
          merchantId: m.id,
        });
        return m.id;
      });
      const profile = await withMerchantContext(app.db, merchantId, (tx) =>
        loadProfile(tx, merchantId),
      );
      return reply.status(201).send(profile);
    },
  );

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

  // ------------------------------------------------------------ profile
  r.get(
    '/:merchantId',
    {
      schema: { tags, params, response: { 200: merchantProfileSchema } },
      preHandler: requireMerchantPermission(),
    },
    async (req) =>
      withMerchantContext(app.db, req.params.merchantId, (tx) =>
        loadProfile(tx, req.params.merchantId),
      ),
  );

  r.patch(
    '/:merchantId',
    {
      schema: {
        tags,
        params,
        body: updateMerchantInputSchema,
        response: { 200: merchantProfileSchema },
      },
      preHandler: requireMerchantPermission('settings.edit'),
    },
    async (req) => {
      const { merchantId } = req.params;
      const { location, logoFileKey, coverFileKey, minOrderCentavos, ...rest } = req.body;

      const imageUrl = async (key: string | null | undefined, purpose: 'logo' | 'cover') => {
        if (key === undefined) return undefined;
        if (key === null) return null;
        if (!key.startsWith(`merchants/${merchantId}/${purpose}/`)) {
          throw new AppError('VALIDATION_FAILED', `Invalid ${purpose} file`);
        }
        if (!(await app.storage.head('public', key))) {
          throw new AppError('VALIDATION_FAILED', `Upload the ${purpose} first`);
        }
        return app.storage.publicUrl(key);
      };
      const logoUrl = await imageUrl(logoFileKey, 'logo');
      const coverUrl = await imageUrl(coverFileKey, 'cover');

      return withMerchantContext(app.db, merchantId, async (tx) => {
        await tx.merchant.update({
          where: { id: merchantId },
          data: {
            ...rest,
            ...(location ? { lat: location.lat, lng: location.lng } : {}),
            ...(minOrderCentavos !== undefined
              ? { minOrderCentavos: BigInt(minOrderCentavos) }
              : {}),
            ...(logoUrl !== undefined ? { logoUrl } : {}),
            ...(coverUrl !== undefined ? { coverUrl } : {}),
            version: { increment: 1 },
          },
        });
        if (location) await assignZone(tx, merchantId);
        await writeAudit(tx, req, {
          action: 'merchant.profile.update',
          targetType: 'merchant',
          targetId: merchantId,
          merchantId,
          metadata: { fields: Object.keys(req.body) },
        });
        return loadProfile(tx, merchantId);
      });
    },
  );

  /** Signed upload for the store logo/cover (public bucket, served by the CDN). */
  r.post(
    '/:merchantId/uploads/image',
    {
      schema: {
        tags,
        params,
        body: requestImageUploadInputSchema,
        response: { 200: presignedUploadSchema },
      },
      preHandler: requireMerchantPermission('settings.edit'),
    },
    async (req) => {
      const { purpose, contentType, sizeBytes } = req.body;
      const key = objectKey(
        `merchants/${req.params.merchantId}/${purpose}`,
        IMAGE_EXT[contentType],
      );
      const up = await app.storage.presignUpload({
        bucket: 'public',
        key,
        contentType,
        contentLength: sizeBytes,
      });
      return { ...up, fileKey: up.key, expiresAt: up.expiresAt.toISOString() };
    },
  );

  // ------------------------------------------------------------ hours & holidays
  const hoursOf = async (tx: Tx, merchantId: string) => {
    const m = await tx.merchant.findUnique({
      where: { id: merchantId },
      include: profileInclude(),
    });
    if (!m) throw new AppError('NOT_FOUND', 'Store not found');
    const today = manilaDateKey(new Date());
    return {
      merchantId,
      weekly: m.storeHours.map(({ dayOfWeek, opensAt, closesAt }) => ({
        dayOfWeek,
        opensAt,
        closesAt,
      })),
      holidays: m.holidayClosures.map(holidayOf).filter((h) => h.date >= today),
    };
  };

  r.get(
    '/:merchantId/hours',
    {
      schema: { tags, params, response: { 200: storeHoursSchema } },
      preHandler: requireMerchantPermission(),
    },
    async (req) =>
      withMerchantContext(app.db, req.params.merchantId, (tx) =>
        hoursOf(tx, req.params.merchantId),
      ),
  );

  r.put(
    '/:merchantId/hours',
    {
      schema: {
        tags,
        params,
        body: setWeeklyHoursInputSchema,
        response: { 200: storeHoursSchema },
      },
      preHandler: requireMerchantPermission('settings.edit'),
    },
    async (req) => {
      const { merchantId } = req.params;
      return withMerchantContext(app.db, merchantId, async (tx) => {
        await tx.storeHours.deleteMany({ where: { merchantId } });
        await tx.storeHours.createMany({
          data: req.body.weekly.map((s) => ({ ...s, merchantId })),
        });
        await tx.merchant.update({
          where: { id: merchantId },
          data: { version: { increment: 1 } },
        });
        await writeAudit(tx, req, {
          action: 'merchant.hours.update',
          targetType: 'merchant',
          targetId: merchantId,
          merchantId,
        });
        return hoursOf(tx, merchantId);
      });
    },
  );

  const holidayParams = params.extend({ date: dateKeySchema });

  r.put(
    '/:merchantId/holidays/:date',
    {
      schema: {
        tags,
        params: holidayParams,
        body: upsertHolidayInputSchema,
        response: { 200: storeHoursSchema },
      },
      preHandler: requireMerchantPermission('settings.edit'),
    },
    async (req) => {
      const { merchantId, date } = req.params;
      const { closed, opensAt, closesAt, note } = req.body;
      const data = {
        closed,
        opensAt: closed ? null : opensAt,
        closesAt: closed ? null : closesAt,
        note,
      };
      return withMerchantContext(app.db, merchantId, async (tx) => {
        await tx.holidayClosure.upsert({
          where: { merchantId_date: { merchantId, date: dateOfKey(date) } },
          create: { merchantId, date: dateOfKey(date), ...data },
          update: data,
        });
        await writeAudit(tx, req, {
          action: 'merchant.holiday.upsert',
          targetType: 'merchant',
          targetId: merchantId,
          merchantId,
          metadata: { date, closed },
        });
        return hoursOf(tx, merchantId);
      });
    },
  );

  r.delete(
    '/:merchantId/holidays/:date',
    {
      schema: { tags, params: holidayParams, response: { 200: storeHoursSchema } },
      preHandler: requireMerchantPermission('settings.edit'),
    },
    async (req) => {
      const { merchantId, date } = req.params;
      return withMerchantContext(app.db, merchantId, async (tx) => {
        await tx.holidayClosure.deleteMany({ where: { merchantId, date: dateOfKey(date) } });
        await writeAudit(tx, req, {
          action: 'merchant.holiday.delete',
          targetType: 'merchant',
          targetId: merchantId,
          merchantId,
          metadata: { date },
        });
        return hoursOf(tx, merchantId);
      });
    },
  );

  // ------------------------------------------------------------ pause / resume
  r.post(
    '/:merchantId/pause',
    {
      schema: {
        tags,
        params,
        body: pauseStoreInputSchema,
        response: { 200: merchantProfileSchema },
      },
      // Busy kitchens pause too, so order handlers may do it, not just settings editors.
      preHandler: requireMerchantPermission('orders.manage'),
    },
    async (req) => {
      const { merchantId } = req.params;
      const { minutes, until, message } = req.body;
      const now = Date.now();
      const pausedUntil = minutes
        ? new Date(now + minutes * 60_000)
        : until
          ? new Date(until)
          : INDEFINITE_PAUSE_UNTIL;
      if (pausedUntil.getTime() <= now) {
        throw new AppError('VALIDATION_FAILED', 'Pause end must be in the future');
      }
      return withMerchantContext(app.db, merchantId, async (tx) => {
        await tx.merchant.update({
          where: { id: merchantId },
          data: { pausedUntil, pauseMessage: message ?? null, version: { increment: 1 } },
        });
        await writeAudit(tx, req, {
          action: 'merchant.pause',
          targetType: 'merchant',
          targetId: merchantId,
          merchantId,
          metadata: { pausedUntil: pausedUntil.toISOString() },
        });
        return loadProfile(tx, merchantId);
      });
    },
  );

  r.post(
    '/:merchantId/resume',
    {
      schema: { tags, params, response: { 200: merchantProfileSchema } },
      preHandler: requireMerchantPermission('orders.manage'),
    },
    async (req) => {
      const { merchantId } = req.params;
      return withMerchantContext(app.db, merchantId, async (tx) => {
        // Manual resume also clears a system auto-pause (e.g. key product sold out).
        await tx.merchant.update({
          where: { id: merchantId },
          data: {
            pausedUntil: null,
            pauseMessage: null,
            autoPausedReason: null,
            autoPausedAt: null,
            version: { increment: 1 },
          },
        });
        await writeAudit(tx, req, {
          action: 'merchant.resume',
          targetType: 'merchant',
          targetId: merchantId,
          merchantId,
        });
        return loadProfile(tx, merchantId);
      });
    },
  );

  await app.register(documentRoutes);
  await app.register(staffRoutes);
}

export { loadProfile };
