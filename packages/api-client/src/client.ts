import {
  type AppPlatform,
  type AuthTokens,
  authTokensSchema,
  ErrorCode,
  type HealthResponse,
  healthResponseSchema,
  Headers,
  type LogoutInput,
  type RefreshTokenInput,
  type RequestOtpInput,
  type RequestOtpResponse,
  requestOtpResponseSchema,
  type User,
  userSchema,
  type VerifyOtpInput,
  type VerifyOtpResponse,
  verifyOtpResponseSchema,
} from '@ebalangay/shared';
import type { z } from 'zod';
import { ApiClientError, errorFromResponse, NETWORK_ERROR } from './errors.js';

type MaybePromise<T> = T | Promise<T>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue =
  string | number | boolean | null | undefined | readonly (string | number)[];

export interface RetryOptions {
  /** Extra attempts after the first. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface ApiClientOptions {
  /** e.g. https://api.ebalangay.ph (no trailing /v1). */
  baseUrl: string;
  /** Current access token; null on web (httpOnly cookie) or when signed out. */
  getToken: () => MaybePromise<string | null>;
  /**
   * Refresh and persist tokens; resolve the new access token (or '' for cookie auth),
   * or null when the session is gone. Called at most once at a time.
   */
  refreshToken: () => Promise<string | null>;
  /** Sent as X-App-Version so the API can force-update old mobile builds. */
  appVersion?: string;
  platform?: AppPlatform;
  onForceUpdate?: (info: { minVersion: string | null }) => void;
  /** Refresh failed: the app should clear its session and show sign-in. */
  onSessionExpired?: () => void;
  /** 'include' for web cookie auth. */
  credentials?: RequestCredentials;
  retry?: Partial<RetryOptions>;
  timeoutMs?: number;
  /** Validate response bodies with the shared Zod schemas (recommended in dev and tests). */
  validateResponses?: boolean;
  fetch?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions<S extends z.ZodType | undefined = undefined> {
  query?: Record<string, QueryValue>;
  body?: unknown;
  schema?: S;
  /** Default true: attach token and refresh on 401. */
  auth?: boolean;
  /** Makes a non-idempotent request (POST/PATCH) safe to retry. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

type Result<S> = S extends z.ZodType ? z.infer<S> : unknown;

const IDEMPOTENT: ReadonlySet<Method> = new Set(['GET', 'PUT', 'DELETE']);
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  const url = `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
    else params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/** Exponential backoff with jitter in [50%, 100%] of the capped delay. */
export function backoffDelay(attempt: number, opts: RetryOptions, random = Math.random): number {
  const capped = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.round(capped * (0.5 + random() / 2));
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? defaultSleep;
  const retry: RetryOptions = { retries: 2, baseDelayMs: 500, maxDelayMs: 8000, ...options.retry };
  const validate = options.validateResponses ?? true;
  let refreshing: Promise<string | null> | null = null;

  /** Single-flight refresh: concurrent 401s queue behind one refresh call. */
  function refreshOnce(): Promise<string | null> {
    refreshing ??= options
      .refreshToken()
      .catch(() => null)
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  async function send(
    method: Method,
    url: string,
    opts: RequestOptions<z.ZodType | undefined>,
    token: string | null,
  ) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    if (options.appVersion) headers[Headers.APP_VERSION] = options.appVersion;
    if (options.platform) headers[Headers.APP_PLATFORM] = options.platform;
    if (opts.idempotencyKey) headers[Headers.IDEMPOTENCY_KEY] = opts.idempotencyKey;

    // Manual linking: AbortSignal.any/timeout are not available on every RN runtime.
    const controller = new AbortController();
    const onAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', onAbort);
    const timer = options.timeoutMs
      ? setTimeout(() => controller.abort(new Error('Request timed out')), options.timeoutMs)
      : undefined;
    try {
      return await doFetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        credentials: options.credentials,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Retries network failures and 502/503/504, only when the request is safe to repeat. */
  async function sendWithRetry(
    method: Method,
    url: string,
    opts: RequestOptions<z.ZodType | undefined>,
    token: string | null,
  ): Promise<Response> {
    const canRetry = IDEMPOTENT.has(method) || Boolean(opts.idempotencyKey);
    for (let attempt = 0; ; attempt++) {
      const last = !canRetry || attempt >= retry.retries;
      let res: Response;
      try {
        res = await send(method, url, opts, token);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (last) throw new ApiClientError(NETWORK_ERROR, 'Network request failed', null, err);
        await sleep(backoffDelay(attempt, retry));
        continue;
      }
      if (last || !RETRYABLE_STATUS.has(res.status)) return res;
      await sleep(backoffDelay(attempt, retry));
    }
  }

  async function request<S extends z.ZodType | undefined = undefined>(
    method: Method,
    path: string,
    opts: RequestOptions<S> = {},
  ): Promise<Result<S>> {
    const url = buildUrl(options.baseUrl, path, opts.query);
    const useAuth = opts.auth !== false;
    let token = useAuth ? await options.getToken() : null;
    let res = await sendWithRetry(method, url, opts, token);

    if (res.status === 401 && useAuth) {
      token = await refreshOnce();
      if (token === null) {
        options.onSessionExpired?.();
        throw await errorFromResponse(res);
      }
      res = await sendWithRetry(method, url, opts, token);
      if (res.status === 401) options.onSessionExpired?.();
    }

    if (!res.ok) {
      const err = await errorFromResponse(res);
      if (err.code === ErrorCode.UPGRADE_REQUIRED) {
        const details = err.details as { minVersion?: unknown } | undefined;
        const minVersion = typeof details?.minVersion === 'string' ? details.minVersion : null;
        options.onForceUpdate?.({ minVersion });
      }
      throw err;
    }

    if (res.status === 204) return undefined as Result<S>;
    const json: unknown = await res.json();
    if (!opts.schema || !validate) return json as Result<S>;
    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiClientError(
        ErrorCode.INTERNAL,
        'Unexpected response shape',
        res.status,
        parsed.error.issues,
      );
    }
    return parsed.data as Result<S>;
  }

  const get = <S extends z.ZodType | undefined = undefined>(path: string, o?: RequestOptions<S>) =>
    request('GET', path, o);
  const post = <S extends z.ZodType | undefined = undefined>(
    path: string,
    body?: unknown,
    o?: RequestOptions<S>,
  ) => request('POST', path, { ...o, body });

  return {
    request,
    health: {
      get: (signal?: AbortSignal): Promise<HealthResponse> =>
        get('/v1/health', { schema: healthResponseSchema, auth: false, signal }),
    },
    auth: {
      requestOtp: (input: RequestOtpInput): Promise<RequestOtpResponse> =>
        post('/v1/auth/otp/request', input, { schema: requestOtpResponseSchema, auth: false }),
      verifyOtp: (input: VerifyOtpInput): Promise<VerifyOtpResponse> =>
        post('/v1/auth/otp/verify', input, { schema: verifyOtpResponseSchema, auth: false }),
      /** Use inside your refreshToken callback. Refresh tokens rotate on every call. */
      refresh: (input: RefreshTokenInput): Promise<AuthTokens> =>
        post('/v1/auth/refresh', input, { schema: authTokensSchema, auth: false }),
      logout: (input: LogoutInput = {}): Promise<void> =>
        post('/v1/auth/logout', input).then(() => undefined),
      me: (signal?: AbortSignal): Promise<User> => get('/v1/me', { schema: userSchema, signal }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
