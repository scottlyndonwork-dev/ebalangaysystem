import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Headers } from '@ebalangay/shared';
import fp from 'fastify-plugin';

/** Helmet, CORS (credentialed, allowlisted web origins) and signed cookies. */
export const securityPlugin = fp(
  async (app) => {
    // JSON API: CSP is for documents (Swagger UI sets its own when enabled).
    await app.register(helmet, { contentSecurityPolicy: false, global: true });

    const allowed = new Set(app.env.CORS_ORIGINS);
    await app.register(cors, {
      // Mobile apps send no Origin and are unaffected; browsers must be on the allowlist.
      origin: (origin, cb) => cb(null, origin === undefined || allowed.has(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: [
        'content-type',
        'authorization',
        Headers.APP_VERSION,
        Headers.APP_PLATFORM,
        Headers.REQUEST_ID,
        Headers.IDEMPOTENCY_KEY,
      ],
      exposedHeaders: [Headers.REQUEST_ID, 'retry-after'],
      maxAge: 600,
    });

    await app.register(cookie, { secret: app.env.COOKIE_SECRET, hook: 'onRequest' });
  },
  { name: 'security', dependencies: ['infra'] },
);
