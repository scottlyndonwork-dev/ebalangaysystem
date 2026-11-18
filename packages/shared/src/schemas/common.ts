import { z } from 'zod';
import { zEnum } from '../enums.js';

export const idSchema = z.uuid();
export const idParamsSchema = z.object({ id: idSchema });

/** ISO-8601 UTC timestamp string as sent over the wire. */
export const timestampSchema = z.iso.datetime({ offset: true });

export const centavosSchema = z.number().int().refine(Number.isSafeInteger, 'Out of range');
export const nonNegativeCentavosSchema = centavosSchema.refine((v) => v >= 0, 'Must be >= 0');
/** Basis points: 1250 = 12.5%. */
export const basisPointsSchema = z.number().int().min(0).max(1_000_000);

/** Philippine mobile number in E.164, e.g. +639171234567. */
export const phPhoneSchema = z
  .string()
  .trim()
  .regex(/^\+639\d{9}$/, 'Use a PH mobile number like +639171234567');

export const localeSchema = z.enum(['en', 'fil', 'ceb']);

export const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof latLngSchema>;

export const urlSchema = z.url().max(2048);
/** "HH:mm", 00:00-24:00 */
export const timeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/);
export const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Opaque cursor pagination used by every list endpoint. */
export const cursorPageQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CursorPageQuery = z.infer<typeof cursorPageQuerySchema>;

export const cursorPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type CursorPage<T> = { items: T[]; nextCursor: string | null };

/** Semver "major.minor.patch" sent by mobile apps in X-App-Version. */
export const appVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  time: z.iso.datetime(),
  checks: z.object({ database: z.enum(['ok', 'down']), redis: z.enum(['ok', 'down']) }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const UploadPurpose = {
  PRODUCT_IMAGE: 'product_image',
  STORE_LOGO: 'store_logo',
  STORE_COVER: 'store_cover',
  STORY_MEDIA: 'story_media',
  REVIEW_PHOTO: 'review_photo',
  DELIVERY_PROOF: 'delivery_proof',
  AVATAR: 'avatar',
  /** Encrypted at rest; never public (RA 10173). */
  ID_DOCUMENT: 'id_document',
  IMPORT_FILE: 'import_file',
} as const;
export const uploadPurposeSchema = zEnum(UploadPurpose);

export const presignUploadInputSchema = z.object({
  purpose: uploadPurposeSchema,
  fileName: z.string().min(1).max(255),
  contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024),
});
export type PresignUploadInput = z.infer<typeof presignUploadInputSchema>;

export const presignUploadResponseSchema = z.object({
  uploadUrl: urlSchema,
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  /** Key to send back to the API when attaching the file to an entity. */
  fileKey: z.string(),
  publicUrl: urlSchema.nullable(),
  expiresAt: timestampSchema,
});
export type PresignUploadResponse = z.infer<typeof presignUploadResponseSchema>;
