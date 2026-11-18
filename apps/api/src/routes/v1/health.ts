import { type HealthResponse, healthResponseSchema } from '@ebalangay/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../../db.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import type { RedisClient } from '../../redis.js';

type CheckStatus = HealthResponse['checks']['database'];

export const healthRoutes =
  (deps: { db: Db; redis: RedisClient; version: string }): FastifyPluginAsync =>
  async (app) => {
    const check = async (name: string, fn: () => Promise<unknown>): Promise<CheckStatus> => {
      try {
        await fn();
        return 'ok';
      } catch (err) {
        app.log.warn({ err }, `health: ${name} check failed`);
        return 'down';
      }
    };

    app
      .withTypeProvider<ZodTypeProvider>()
      .get(
        '/health',
        { schema: { response: { 200: healthResponseSchema, 503: healthResponseSchema } } },
        async (_req, reply) => {
          const [database, redis] = await Promise.all([
            check('database', () => deps.db.$queryRaw`SELECT 1`),
            check('redis', () => deps.redis.ping()),
          ]);
          const ok = database === 'ok' && redis === 'ok';
          return reply.status(ok ? 200 : 503).send({
            status: ok ? 'ok' : 'degraded',
            version: deps.version,
            time: new Date().toISOString(),
            checks: { database, redis },
          });
        },
      );
  };
