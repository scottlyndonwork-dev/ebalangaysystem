import rateLimit from '@fastify/rate-limit';
import { ErrorCode } from '@ebalangay/shared';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';

/** Per-route overrides, e.g. `config: { rateLimit: RATE_LIMITS.auth }`. */
export const RATE_LIMITS = {
  /** /v1/auth/*: per IP. OTP sends have their own per-phone/IP limits in the auth service. */
  auth: { max: 10, timeWindow: '1 minute' },
  /** Login with password / TOTP: slow down credential stuffing. */
  credentials: { max: 5, timeWindow: '1 minute' },
} as const;

/** Redis-backed so limits hold across API instances. Fails open if Redis is unavailable. */
export const rateLimitPlugin = fp(
  async (app) => {
    if (!app.env.RATE_LIMIT_ENABLED) return;
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: '1 minute',
      redis: app.redis,
      nameSpace: 'eb:rl:',
      skipOnError: true,
      keyGenerator: (req) => req.ip,
      errorResponseBuilder: (_req, ctx) =>
        new AppError(ErrorCode.RATE_LIMITED, 'Too many requests', {
          retryAfterSeconds: Math.ceil(ctx.ttl / 1000),
        }),
    });
  },
  { name: 'rate-limit', dependencies: ['infra'] },
);
