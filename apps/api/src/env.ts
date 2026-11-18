import { appVersionSchema } from '@ebalangay/shared';
import { z } from 'zod';

const list = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );
const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters`);
const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.url(),
    REDIS_URL: z.url().default('redis://localhost:6379'),
    SENTRY_DSN: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
    /** Mobile apps below this X-App-Version get 426 UPGRADE_REQUIRED. */
    MIN_APP_VERSION: appVersionSchema.default('0.0.0'),

    /** Browser origins allowed to call the API with credentials (merchant-web, admin-web). */
    CORS_ORIGINS: list,
    /** /docs (Swagger UI). Defaults to on outside production. */
    DOCS_ENABLED: bool,
    RATE_LIMIT_ENABLED: bool,
    /**
     * Reverse proxies in front of the API (Railway/Cloudflare = 1). Only that many
     * X-Forwarded-For hops are trusted, so clients can't spoof their IP past rate limits.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

    // Auth
    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
    JWT_ISSUER: z.string().default('ebalangay-api'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(180).default(30),
    /** HMAC key for OTP and refresh-token hashes. */
    OTP_PEPPER: secret('OTP_PEPPER'),
    COOKIE_SECRET: secret('COOKIE_SECRET'),
    /** e.g. .ebalangay.ph in production so business./admin. subdomains share cookies. */
    COOKIE_DOMAIN: z.string().optional(),
    /** base64 of 32 random bytes; AES-256-GCM for TOTP secrets and payout accounts. */
    DATA_ENCRYPTION_KEY: z
      .string()
      .refine(
        (v) => Buffer.from(v, 'base64').length === 32,
        'DATA_ENCRYPTION_KEY must be base64 of 32 bytes',
      ),
    /** IPs/CIDRs allowed to call /v1/admin. Empty = allow all (dev only). */
    ADMIN_IP_ALLOWLIST: list,

    // SMS
    SMS_DRIVER: z.enum(['console', 'semaphore']).default('console'),
    SEMAPHORE_API_KEY: z.string().optional(),
    SEMAPHORE_SENDER_NAME: z.string().default('EBALANGAY'),
  })
  .superRefine((env, ctx) => {
    if (env.SMS_DRIVER === 'semaphore' && !env.SEMAPHORE_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['SEMAPHORE_API_KEY'],
        message: 'Required when SMS_DRIVER=semaphore',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (env.SMS_DRIVER !== 'semaphore') {
        ctx.addIssue({
          code: 'custom',
          path: ['SMS_DRIVER'],
          message: 'Must be semaphore in production',
        });
      }
      if (env.ADMIN_IP_ALLOWLIST.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['ADMIN_IP_ALLOWLIST'],
          message: 'Required in production',
        });
      }
      if (env.CORS_ORIGINS.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'Required in production' });
      }
    }
  })
  .transform((env) => ({
    ...env,
    DOCS_ENABLED: env.DOCS_ENABLED ?? env.NODE_ENV !== 'production',
    RATE_LIMIT_ENABLED: env.RATE_LIMIT_ENABLED ?? true,
    isProduction: env.NODE_ENV === 'production',
  }));

export type Env = z.infer<typeof envSchema>;
export type EnvInput = Partial<Record<keyof z.input<typeof envSchema>, string>>;

/** Fails fast with every problem listed; values are never printed. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
