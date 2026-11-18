import {
  adminMerchantDetailSchema,
  cursorPageSchema,
  listMerchantApplicationsQuerySchema,
  merchantApplicationSchema,
  merchantDocumentSchema,
  merchantProfileSchema,
  missingMerchantDocuments,
  rejectApplicationInputSchema,
  reviewDocumentInputSchema,
  signedDownloadSchema,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { toDocument } from '../merchants/documents.js';
import { profileInclude, toProfile } from '../merchants/service.js';

const tags = ['admin-merchants'];
const merchantParams = z.object({ merchantId: z.uuid() });
const documentParams = z.object({ documentId: z.uuid() });

/** Merchant application review. Mounted inside adminRoutes (IP allowlist + admin + TOTP). */
export async function adminMerchantRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/merchant-applications',
    {
      schema: {
        tags,
        querystring: listMerchantApplicationsQuerySchema,
        response: { 200: cursorPageSchema(merchantApplicationSchema) },
      },
    },
    async (req) => {
      const { cursor, limit, status } = req.query;
      // UUIDv7 ids are time-ordered: oldest application first (FIFO review queue).
      const rows = await app.db.merchant.findMany({
        where: { status, ...(cursor ? { id: { gt: cursor } } : {}) },
        include: { _count: { select: { documents: true } } },
        orderBy: { id: 'asc' },
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      return {
        items: page.map((m) => ({
          id: m.id,
          slug: m.slug,
          name: m.name,
          businessType: m.businessType,
          status: m.status,
          phone: m.phone,
          barangay: m.barangay,
          city: m.city,
          documentCount: m._count.documents,
          applicationSubmittedAt: m.applicationSubmittedAt?.toISOString() ?? null,
          createdAt: m.createdAt.toISOString(),
        })),
        nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );

  r.get(
    '/merchants/:merchantId',
    { schema: { tags, params: merchantParams, response: { 200: adminMerchantDetailSchema } } },
    async (req) => {
      const { merchantId } = req.params;
      const m = await app.db.merchant.findUnique({
        where: { id: merchantId },
        include: {
          ...profileInclude(),
          documents: { orderBy: { createdAt: 'asc' } },
          staff: {
            where: { rolePreset: 'owner' },
            include: { user: { select: { phone: true } } },
          },
        },
      });
      if (!m) throw new AppError('NOT_FOUND', 'Store not found');
      return {
        merchant: toProfile(m),
        documents: m.documents.map(toDocument),
        owners: m.staff.map((s) => ({
          userId: s.userId,
          displayName: s.displayName,
          phone: s.user.phone,
        })),
      };
    },
  );

  /** 5-minute link to view a private document. Every view is audit-logged (RA 10173). */
  r.post(
    '/merchant-documents/:documentId/download',
    { schema: { tags, params: documentParams, response: { 200: signedDownloadSchema } } },
    async (req) => {
      const doc = await app.db.merchantDocument.findUnique({
        where: { id: req.params.documentId },
      });
      if (!doc) throw new AppError('NOT_FOUND', 'Document not found');
      const link = await app.storage.presignDownload(doc.fileKey, 300);
      await writeAudit(app.db, req, {
        action: 'merchant.document.view',
        targetType: 'merchant_document',
        targetId: doc.id,
        merchantId: doc.merchantId,
        metadata: { type: doc.type },
      });
      return { url: link.url, expiresAt: link.expiresAt.toISOString() };
    },
  );

  r.patch(
    '/merchant-documents/:documentId',
    {
      schema: {
        tags,
        params: documentParams,
        body: reviewDocumentInputSchema,
        response: { 200: merchantDocumentSchema },
      },
    },
    async (req) => {
      const { status, notes } = req.body;
      const doc = await app.db.$transaction(async (tx) => {
        const existing = await tx.merchantDocument.findUnique({
          where: { id: req.params.documentId },
        });
        if (!existing) throw new AppError('NOT_FOUND', 'Document not found');
        const updated = await tx.merchantDocument.update({
          where: { id: existing.id },
          data: {
            status,
            notes: notes ?? null,
            reviewedById: req.auth?.userId ?? null,
            reviewedAt: new Date(),
          },
        });
        await writeAudit(tx, req, {
          action: `merchant.document.${status === 'approved' ? 'approve' : 'reject'}`,
          targetType: 'merchant_document',
          targetId: existing.id,
          merchantId: existing.merchantId,
          metadata: { type: existing.type },
        });
        return updated;
      });
      return toDocument(doc);
    },
  );

  r.post(
    '/merchants/:merchantId/approve',
    { schema: { tags, params: merchantParams, response: { 200: merchantProfileSchema } } },
    async (req) => {
      const { merchantId } = req.params;
      const m = await app.db.$transaction(async (tx) => {
        const approvedDocs = await tx.merchantDocument.findMany({
          where: { merchantId, status: 'approved' },
          select: { type: true },
        });
        const missing = missingMerchantDocuments(approvedDocs.map((d) => d.type));
        if (missing.length) {
          throw new AppError('VALIDATION_FAILED', 'Approve the required documents first', {
            missing,
          });
        }
        const moved = await tx.merchant.updateMany({
          where: { id: merchantId, status: 'pending_review' },
          data: {
            status: 'active',
            applicationReviewNote: null,
            applicationReviewedAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (moved.count !== 1) throw new AppError('CONFLICT', 'Application is not awaiting review');
        await writeAudit(tx, req, {
          action: 'merchant.application.approve',
          targetType: 'merchant',
          targetId: merchantId,
          merchantId,
        });
        return tx.merchant.findUniqueOrThrow({
          where: { id: merchantId },
          include: profileInclude(),
        });
      });
      return toProfile(m);
    },
  );

  r.post(
    '/merchants/:merchantId/reject',
    {
      schema: {
        tags,
        params: merchantParams,
        body: rejectApplicationInputSchema,
        response: { 200: merchantProfileSchema },
      },
    },
    async (req) => {
      const { merchantId } = req.params;
      const m = await app.db.$transaction(async (tx) => {
        const moved = await tx.merchant.updateMany({
          where: { id: merchantId, status: 'pending_review' },
          data: {
            status: 'rejected',
            applicationReviewNote: req.body.reason,
            applicationReviewedAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (moved.count !== 1) throw new AppError('CONFLICT', 'Application is not awaiting review');
        await writeAudit(tx, req, {
          action: 'merchant.application.reject',
          targetType: 'merchant',
          targetId: merchantId,
          merchantId,
        });
        return tx.merchant.findUniqueOrThrow({
          where: { id: merchantId },
          include: profileInclude(),
        });
      });
      return toProfile(m);
    },
  );
}
