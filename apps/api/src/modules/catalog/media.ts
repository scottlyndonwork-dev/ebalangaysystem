import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import {
  MAX_IMAGE_BYTES,
  MAX_IMPORT_BYTES,
  MAX_PRODUCT_IMAGES,
  catalogImportQuerySchema,
  catalogImportReportSchema,
  productSchema,
  reorderImagesInputSchema,
} from '@ebalangay/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { withMerchantContext } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { authOf, requireMerchantPermission } from '../../plugins/auth.js';
import { applyImport, parseImport } from './import.js';
import { loadProduct, toProduct } from './service.js';

const tags = ['catalog'];
const params = z.object({ merchantId: z.uuid() });
const productParams = params.extend({ productId: z.uuid() });
const imageParams = productParams.extend({ imageId: z.uuid() });

/** Decompression-bomb guard: refuse anything over ~40 MP before decoding. */
const MAX_INPUT_PIXELS = 40_000_000;
const RENDITIONS = ['thumb', 'display', 'full'] as const;

/** Reads the single uploaded file; 413 (via the error plugin) when it is over `maxBytes`. */
async function readFile(req: FastifyRequest, maxBytes: number): Promise<Buffer> {
  const file = await req.file({ limits: { fileSize: maxBytes, files: 1 } });
  if (!file) throw new AppError('VALIDATION_FAILED', 'Attach a file', { field: 'file' });
  return file.toBuffer();
}

/**
 * Re-encodes the upload (never stored as sent): EXIF orientation applied, metadata stripped.
 * thumb = 200px square crop, display = 800px, full = up to 2048px.
 */
export async function renderProductImage(
  input: Buffer,
): Promise<Record<(typeof RENDITIONS)[number], Buffer>> {
  let format: string | undefined;
  try {
    format = (await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
  } catch {
    throw new AppError('VALIDATION_FAILED', 'File is not a readable image', { field: 'file' });
  }
  if (!format || !['jpeg', 'png', 'webp'].includes(format)) {
    throw new AppError('VALIDATION_FAILED', 'Use a JPEG, PNG or WebP image', { field: 'file' });
  }
  const base = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
  const [thumb, display, full] = await Promise.all([
    base.clone().resize(200, 200, { fit: 'cover' }).webp({ quality: 75 }).toBuffer(),
    base
      .clone()
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer(),
    base
      .clone()
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer(),
  ]);
  return { thumb, display, full };
}

const keysOf = (prefix: string) => RENDITIONS.map((r) => `${prefix}/${r}.webp`);

/** Routes that take multipart bodies; the parser is registered only in this scope. */
export async function catalogMediaRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: Math.max(MAX_IMAGE_BYTES, MAX_IMPORT_BYTES),
      files: 1,
      fields: 0,
      parts: 1,
    },
  });
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/:merchantId/products/:productId/images',
    {
      schema: { tags, params: productParams, response: { 201: productSchema } },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req, reply) => {
      const { merchantId, productId } = req.params;
      const count = await withMerchantContext(app.db, merchantId, async (tx) => {
        await loadProduct(tx, merchantId, productId);
        return tx.productImage.count({ where: { productId } });
      });
      if (count >= MAX_PRODUCT_IMAGES) {
        throw new AppError('CONFLICT', `A product can have at most ${MAX_PRODUCT_IMAGES} images`);
      }

      const images = await renderProductImage(await readFile(req, MAX_IMAGE_BYTES));
      const prefix = `merchants/${merchantId}/products/${productId}/${randomUUID()}`;
      const [thumbKey, displayKey, fullKey] = keysOf(prefix) as [string, string, string];
      await Promise.all([
        app.storage.put('public', thumbKey, images.thumb, 'image/webp'),
        app.storage.put('public', displayKey, images.display, 'image/webp'),
        app.storage.put('public', fullKey, images.full, 'image/webp'),
      ]);

      try {
        const product = await withMerchantContext(app.db, merchantId, async (tx) => {
          await loadProduct(tx, merchantId, productId);
          const last = await tx.productImage.aggregate({
            where: { productId },
            _max: { sortOrder: true },
            _count: true,
          });
          if (last._count >= MAX_PRODUCT_IMAGES) {
            throw new AppError(
              'CONFLICT',
              `A product can have at most ${MAX_PRODUCT_IMAGES} images`,
            );
          }
          await tx.productImage.create({
            data: {
              productId,
              url: app.storage.publicUrl(fullKey),
              thumbUrl: app.storage.publicUrl(thumbKey),
              displayUrl: app.storage.publicUrl(displayKey),
              fileKey: prefix,
              sortOrder: (last._max.sortOrder ?? -1) + 1,
            },
          });
          await tx.product.update({
            where: { id: productId },
            data: { version: { increment: 1 } },
          });
          return toProduct(await loadProduct(tx, merchantId, productId));
        });
        return reply.status(201).send(product);
      } catch (err) {
        await app.storage.remove('public', keysOf(prefix)).catch(() => undefined);
        throw err;
      }
    },
  );

  r.delete(
    '/:merchantId/products/:productId/images/:imageId',
    {
      schema: { tags, params: imageParams, response: { 200: productSchema } },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req) => {
      const { merchantId, productId, imageId } = req.params;
      const { product, fileKey } = await withMerchantContext(app.db, merchantId, async (tx) => {
        await loadProduct(tx, merchantId, productId);
        const img = await tx.productImage.findFirst({ where: { id: imageId, productId } });
        if (!img) throw new AppError('NOT_FOUND', 'Image not found');
        await tx.productImage.delete({ where: { id: imageId } });
        await tx.product.update({ where: { id: productId }, data: { version: { increment: 1 } } });
        return {
          product: toProduct(await loadProduct(tx, merchantId, productId)),
          fileKey: img.fileKey,
        };
      });
      if (fileKey) {
        await app.storage
          .remove('public', keysOf(fileKey))
          .catch((err: unknown) => req.log.warn({ err, fileKey }, 'image cleanup failed'));
      }
      return product;
    },
  );

  r.put(
    '/:merchantId/products/:productId/images/order',
    {
      schema: {
        tags,
        params: productParams,
        body: reorderImagesInputSchema,
        response: { 200: productSchema },
      },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req) => {
      const { merchantId, productId } = req.params;
      const { ids } = req.body;
      return withMerchantContext(app.db, merchantId, async (tx) => {
        const p = await loadProduct(tx, merchantId, productId);
        const current = new Set(p.images.map((i) => i.id));
        if (ids.length !== current.size || !ids.every((id) => current.has(id))) {
          throw new AppError('VALIDATION_FAILED', 'List every image of the product exactly once');
        }
        for (const [sortOrder, id] of ids.entries()) {
          await tx.productImage.update({ where: { id }, data: { sortOrder } });
        }
        await tx.product.update({ where: { id: productId }, data: { version: { increment: 1 } } });
        return toProduct(await loadProduct(tx, merchantId, productId));
      });
    },
  );

  /**
   * Bulk CSV import. All rows are validated first; any error → nothing is written and every row
   * error is reported. `?dryRun=true` validates only.
   */
  r.post(
    '/:merchantId/catalog/import',
    {
      schema: {
        tags,
        params,
        querystring: catalogImportQuerySchema,
        response: { 200: catalogImportReportSchema },
      },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req) => {
      const { merchantId } = req.params;
      const csv = await readFile(req, MAX_IMPORT_BYTES);
      const actorUserId = authOf(req).userId;
      return withMerchantContext(
        app.db,
        merchantId,
        async (tx) => {
          const plan = await parseImport(tx, merchantId, csv);
          if (plan.errors.length || req.query.dryRun) {
            return { ...plan.summary, applied: false, errors: plan.errors };
          }
          await applyImport(tx, merchantId, plan, actorUserId);
          return { ...plan.summary, applied: true, errors: [] };
        },
        { timeout: 120_000 },
      );
    },
  );
}
