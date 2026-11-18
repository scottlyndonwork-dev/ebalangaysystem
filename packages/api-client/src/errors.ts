import { apiErrorSchema, ErrorCode } from '@ebalangay/shared';

/** Client-only code for requests that never reached the server. */
export const NETWORK_ERROR = 'NETWORK' as const;
export type ClientErrorCode = ErrorCode | typeof NETWORK_ERROR;

export class ApiClientError extends Error {
  override name = 'ApiClientError';
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }

  /** i18n key in the `errors` namespace, e.g. t(err.i18nKey). */
  get i18nKey(): `errors:${ClientErrorCode}` {
    return `errors:${this.code}`;
  }
}

export function isApiClientError(err: unknown): err is ApiClientError {
  return err instanceof ApiClientError;
}

/** Build an ApiClientError from a non-2xx response, tolerating non-JSON bodies. */
export async function errorFromResponse(res: Response): Promise<ApiClientError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Proxies (Cloudflare, Railway) may return HTML on 502/503.
  }
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) {
    const e = parsed.data.error;
    return new ApiClientError(e.code, e.message, res.status, e.details, e.requestId);
  }
  const code =
    res.status === 401
      ? ErrorCode.UNAUTHENTICATED
      : res.status === 426
        ? ErrorCode.UPGRADE_REQUIRED
        : res.status === 429
          ? ErrorCode.RATE_LIMITED
          : res.status >= 500
            ? ErrorCode.SERVICE_UNAVAILABLE
            : ErrorCode.VALIDATION_FAILED;
  return new ApiClientError(code, `HTTP ${res.status}`, res.status);
}
