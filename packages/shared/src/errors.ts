import { z } from 'zod';
import { type ValueOf, zEnum } from './enums.js';

export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  STORE_CLOSED: 'STORE_CLOSED',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  OUT_OF_DELIVERY_ZONE: 'OUT_OF_DELIVERY_ZONE',
  VOUCHER_INVALID: 'VOUCHER_INVALID',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  UPGRADE_REQUIRED: 'UPGRADE_REQUIRED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = ValueOf<typeof ErrorCode>;
export const errorCodeSchema = zEnum(ErrorCode);

/** HTTP status for each error code. The API uses this; clients may use it for fallbacks. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  OTP_INVALID: 400,
  OTP_EXPIRED: 400,
  STORE_CLOSED: 422,
  OUT_OF_STOCK: 422,
  OUT_OF_DELIVERY_ZONE: 422,
  VOUCHER_INVALID: 422,
  INSUFFICIENT_BALANCE: 422,
  PAYMENT_FAILED: 402,
  UPGRADE_REQUIRED: 426,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
};

/** Inner error shape: { code, message, details }. */
export const apiErrorBodySchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
  requestId: z.string().optional(),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** Every non-2xx API response body. */
export const apiErrorSchema = z.object({ error: apiErrorBodySchema });
export type ApiError = z.infer<typeof apiErrorSchema>;
