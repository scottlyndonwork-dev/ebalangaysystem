import { z } from 'zod';
import { ErrorCode } from '../enums.js';

export const idSchema = z.uuid();
export const idParamsSchema = z.object({ id: idSchema });

export const centavosSchema = z.number().int().refine(Number.isSafeInteger, 'Out of range');
export const nonNegativeCentavosSchema = centavosSchema.refine((v) => v >= 0, 'Must be >= 0');

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

export const errorCodeSchema = z.enum(ErrorCode);

export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  time: z.iso.datetime(),
  checks: z.object({ database: z.enum(['ok', 'down']), redis: z.enum(['ok', 'down']) }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
