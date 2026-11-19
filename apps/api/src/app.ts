import { randomUUID } from 'node:crypto';
import { Headers } from '@ebalangay/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { Env } from './env.js';
import { createSmsSender, type SmsSender } from './lib/sms.js';
import { createStorage, type Storage } from './lib/storage.js';
import { serializerCompiler, validatorCompiler } from './lib/zod-provider.js';
import { adminRoutes } from './modules/admin/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { searchRoutes } from './modules/browse/search.js';
import { browseStoreRoutes } from './modules/browse/stores.js';
import { healthRoutes } from './modules/health/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { groupCartRoutes } from './modules/carts/group.js';
import { cartRoutes } from './modules/carts/routes.js';
import { merchantRoutes } from './modules/merchants/routes.js';
import { meStoreRoutes, storeRoutes } from './modules/stores/routes.js';
import { meRoutes } from './modules/users/routes.js';
import { registerAppVersionCheck } from './plugins/app-version.js';
import { authPlugin } from './plugins/auth.js';
import { registerErrorHandling } from './plugins/errors.js';
import { infraPlugin } from './plugins/infra.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import { securityPlugin } from './plugins/security.js';
import { swaggerPlugin } from './plugins/swagger.js';
import type { RedisClient } from './redis.js';

export { API_VERSION } from './version.js';

export interface AppDeps {
  env: Env;
  db: Db;
  redis: RedisClient;
  /** Defaults to the driver selected by SMS_DRIVER. Tests pass a MemorySms. */
  sms?: SmsSender;
  /** Defaults to the driver selected by STORAGE_DRIVER. Tests pass a MemoryStorage. */
  storage?: Storage;
}

/** Never log secrets: tokens, OTP codes, passwords, TOTP codes, card data. */
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.code',
  '*.otp',
  '*.totpCode',
  '*.accessToken',
  '*.refreshToken',
  '*.token',
  '*.cardNumber',
  '*.cvc',
];

export async function buildApp({
  env,
  db,
  redis,
  sms,
  storage,
}: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: { paths: REDACT, censor: '[redacted]' },
      ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
    genReqId: (req) => {
      const incoming = req.headers[Headers.REQUEST_ID];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    },
    requestIdHeader: false,
    bodyLimit: 1_048_576,
    // Trust only the first TRUST_PROXY_HOPS hops (i = 0 is the socket peer).
    trustProxy: (_addr: string, i: number) => i < env.TRUST_PROXY_HOPS,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onSend', async (req, reply) => {
    void reply.header(Headers.REQUEST_ID, req.id);
  });

  registerErrorHandling(app);
  await app.register(infraPlugin, {
    env,
    db,
    redis,
    sms: sms ?? createSmsSender(env),
    storage: storage ?? createStorage(env),
  });
  await app.register(securityPlugin);
  await app.register(authPlugin);
  await app.register(rateLimitPlugin);
  await app.register(swaggerPlugin);
  registerAppVersionCheck(app, env.MIN_APP_VERSION);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(meRoutes, { prefix: '/v1/me' });
  await app.register(meStoreRoutes, { prefix: '/v1/me' });
  await app.register(merchantRoutes, { prefix: '/v1/merchants' });
  await app.register(catalogRoutes, { prefix: '/v1/merchants' });
  await app.register(storeRoutes, { prefix: '/v1/stores' });
  await app.register(browseStoreRoutes, { prefix: '/v1/stores' });
  await app.register(searchRoutes, { prefix: '/v1/search' });
  await app.register(cartRoutes, { prefix: '/v1/carts' });
  await app.register(groupCartRoutes, { prefix: '/v1/group-carts' });
  await app.register(adminRoutes, { prefix: '/v1/admin' });

  return app;
}
