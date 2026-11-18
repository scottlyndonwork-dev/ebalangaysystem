import { ErrorCode } from '@ebalangay/shared';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UPGRADE_REQUIRED: 426,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** Throw this from handlers; the error plugin turns it into the shared ApiError shape. */
export class AppError extends Error {
  override name = 'AppError';
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    message: string = code,
    readonly details?: unknown,
  ) {
    super(message);
    this.statusCode = STATUS[code];
  }
}
