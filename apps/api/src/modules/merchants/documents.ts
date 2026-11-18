import {
  MAX_DOCUMENT_BYTES,
  addMerchantDocumentInputSchema,
  manilaWallTimeToUtc,
  merchantDocumentSchema,
  merchantProfileSchema,
  missingMerchantDocuments,
  presignedUploadSchema,
  requestDocumentUploadInputSchema,
  type MerchantDocument,
  type MerchantDocumentType,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withMerchantContext } from '../../db.js';
import type { MerchantDocument as DocumentRow } from '../../generated/prisma/client.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { objectKey } from '../../lib/storage.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { requireMerchantPermission } from '../../plugins/auth.js';
import { profileInclude, toProfile } from './service.js';

const tags = ['merchant-onboarding'];
const params = z.object({ merchantId: z.uuid() });
const DOC_EXT = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
/** Documents can be changed only while the application is editable. */
const EDITABLE = ['draft', 'rejected'];

export function toDocument(d: DocumentRow): MerchantDocument {
  return {
    id: d.id,
    type: d.type as MerchantDocumentType,
    status: d.status,
    notes: d.notes,
    expiresAt: d.expiresAt?.toISOString() ?? null,
    reviewedAt: d.reviewedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

/**
 * Onboarding documents. Files go straight from the app to the PRIVATE bucket via a signed PUT;
 * the API never sees the bytes. Nobody gets a public URL; admins view through 5-minute links.
 */
export async function documentRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/:merchantId/documents/upload-url',
    {
      schema: {
        tags,
        params,
        body: requestDocumentUploadInputSchema,
        response: { 200: presignedUploadSchema },
      },
      preHandler: requireMerchantPermission('settings.edit'),
    },
    async (req) => {
      const { contentType, sizeBytes } = req.body;
      const key = objectKey(`merchants/${req.params.merchantId}/documents`, DOC_EXT[contentType]);
      const up = await app.storage.presignUpload({
        bucket: 'private',
        key,
        contentType,
        contentLength: sizeBytes,
      });
      return { ...up, fileKey: up.key, expiresAt: up.expiresAt.toISOString() };
    },
  );

  r.post(
    '/:merchantId/documents',
    {
      schema: {
        tags,
        params,
        body: addMerchantDocumentInputSchema,
        response: { 201: merchantDocumentSchema },
      },
      preHandler: requireMerchantPermission('settings.edit'),
    },
    async (req, reply) => {
      const { merchantId } = req.params;
      const { type, fileKey, expiresOn } = req.body;
      if (!fileKey.startsWith(`merchants/${merchantId}/documents/`)) {
        throw new AppError('VALIDATION_FAILED', 'Invalid document file');
      }
      const stored = await app.storage.head('private', fileKey);
      if (!stored) throw new AppError('VALIDATION_FAILED', 'Upload the file first');
      if (stored.size > MAX_DOCUMENT_BYTES) {
        throw new AppError('VALIDATION_FAILED', 'File is too large');
      }

      const doc = await withMerchantContext(app.db, merchantId, async (tx) => {
        const m = await tx.merchant.findUnique({
          where: { id: merchantId },
          select: { status: true },
        });
        if (!m) throw new AppError('NOT_FOUND', 'Store not found');
        // Active stores may upload renewals (e.g. a new mayor's permit); admins review those too.
        if (m.status === 'pending_review') {
          throw new AppError('CONFLICT', 'Your application is under review');
        }
        if (await tx.merchantDocument.findFirst({ where: { merchantId, fileKey } })) {
          throw new AppError('CONFLICT', 'This file was already added');
        }
        const created = await tx.merchantDocument.create({
          data: {
            merchantId,
            type,
            fileKey,
            expiresAt: expiresOn ? manilaWallTimeToUtc(expiresOn, '23:59') : null,
          },
        });
        await writeAudit(tx, req, {
          action: 'merchant.document.add',
          targetType: 'merchant_document',
          targetId: created.id,
          merchantId,
          metadata: { type },
        });
        return created;
      });
      return reply.status(201).send(toDocument(doc));
    },
  );

  r.get(
    '/:merchantId/documents',
    {
      schema: {
        tags,
        params,
        response: { 200: z.object({ items: z.array(merchantDocumentSchema) }) },
      },
      preHandler: requireMerchantPermission('settings.edit'),
    },
    async (req) => {
      const rows = await withMerchantContext(app.db, req.params.merchantId, (tx) =>
        tx.merchantDocument.findMany({ orderBy: { createdAt: 'asc' } }),
      );
      return { items: rows.map(toDocument) };
    },
  );

  r.delete(
    '/:merchantId/documents/:documentId',
    {
      schema: { tags, params: params.extend({ documentId: z.uuid() }) },
      preHandler: requireMerchantPermission('settings.edit'),
    },
    async (req, reply) => {
      const { merchantId, documentId } = req.params;
      await withMerchantContext(app.db, merchantId, async (tx) => {
        const doc = await tx.merchantDocument.findFirst({
          where: { id: documentId, merchantId },
          include: { merchant: { select: { status: true } } },
        });
        if (!doc) throw new AppError('NOT_FOUND', 'Document not found');
        if (doc.status === 'approved' || !EDITABLE.includes(doc.merchant.status)) {
          throw new AppError('CONFLICT', 'This document can no longer be removed');
        }
        await tx.merchantDocument.delete({ where: { id: documentId } });
        await writeAudit(tx, req, {
          action: 'merchant.document.delete',
          targetType: 'merchant_document',
          targetId: documentId,
          merchantId,
        });
      });
      return reply.status(204).send();
    },
  );

  r.post(
    '/:merchantId/application/submit',
    {
      schema: { tags, params, response: { 200: merchantProfileSchema } },
      preHandler: requireMerchantPermission('settings.edit'),
    },
    async (req) => {
      const { merchantId } = req.params;
      return withMerchantContext(app.db, merchantId, async (tx) => {
        const m = await tx.merchant.findUnique({
          where: { id: merchantId },
          select: { status: true },
        });
        if (!m) throw new AppError('NOT_FOUND', 'Store not found');
        if (!EDITABLE.includes(m.status)) {
          throw new AppError('CONFLICT', 'This application was already submitted');
        }
        const docs = await tx.merchantDocument.findMany({
          where: { merchantId, status: { in: ['pending', 'approved'] } },
          select: { type: true },
        });
        const missing = missingMerchantDocuments(docs.map((d) => d.type));
        if (missing.length) {
          throw new AppError('VALIDATION_FAILED', 'Some required documents are missing', {
            missing,
          });
        }
        // Conditional update: two concurrent submits can't both pass.
        const moved = await tx.merchant.updateMany({
          where: { id: merchantId, status: { in: EDITABLE as ('draft' | 'rejected')[] } },
          data: {
            status: 'pending_review',
            applicationSubmittedAt: new Date(),
            applicationReviewNote: null,
            version: { increment: 1 },
          },
        });
        if (moved.count !== 1) throw new AppError('CONFLICT', 'Application changed, try again');
        await writeAudit(tx, req, {
          action: 'merchant.application.submit',
          targetType: 'merchant',
          targetId: merchantId,
          merchantId,
        });
        const full = await tx.merchant.findUniqueOrThrow({
          where: { id: merchantId },
          include: profileInclude(),
        });
        return toProfile(full);
      });
    },
  );
}
