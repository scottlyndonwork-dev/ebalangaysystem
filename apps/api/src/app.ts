import { randomUUID } from 'node:crypto';
import { Headers } from '@ebalangay/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { Env } from './env.js';
import { serializerCompiler, validatorCompiler } from './lib/zod-provider.js';
import { registerAppVersionCheck } from './plugins/app-version.js';
import { registerErrorHandling } from './plugins/errors.js';
import type { RedisClient } from './redis.js';
import { healthRoutes } from './routes/v1/health.js';

export const API_VERSION = '0.1.0';

export interface AppDeps {
  env: Env;
  db: Db;
  redis: RedisClient;
}

export async function buildApp({ env, db, redis }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
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
    trustProxy: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onSend', async (req, reply) => {
    void reply.header(Headers.REQUEST_ID, req.id);
  });

  registerErrorHandling(app);
  registerAppVersionCheck(app, env.MIN_APP_VERSION);

  await app.register(
    async (v1) => {
      await v1.register(healthRoutes({ db, redis, version: API_VERSION }));
    },
    { prefix: '/v1' },
  );

  return app;
}
