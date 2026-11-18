import { ERROR_HTTP_STATUS, type ErrorCode } from '@ebalangay/shared';

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
    this.statusCode = ERROR_HTTP_STATUS[code];
  }
}
