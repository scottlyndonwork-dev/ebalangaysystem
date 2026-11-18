import { type HealthResponse, healthResponseSchema } from '@ebalangay/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { API_VERSION } from '../../version.js';

type CheckStatus = HealthResponse['checks']['database'];
const livenessSchema = z.object({ status: z.literal('ok'), version: z.string() });

/**
 * /health  liveness: the process is up (no dependency checks, never 503 for a DB blip).
 * /ready   readiness: Postgres + Redis reachable; 503 tells the load balancer to drain.
 * /v1/health is kept for existing clients and behaves like /ready.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const check = async (name: string, fn: () => Promise<unknown>): Promise<CheckStatus> => {
    try {
      await fn();
      return 'ok';
    } catch (err) {
      app.log.warn({ err }, `health: ${name} check failed`);
      return 'down';
    }
  };

  const ready = async (reply: FastifyReply) => {
    const [database, redis] = await Promise.all([
      check('database', () => app.db.$queryRaw`SELECT 1`),
      check('redis', () => app.redis.ping()),
    ]);
    const ok = database === 'ok' && redis === 'ok';
    return reply.status(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'degraded',
      version: API_VERSION,
      time: new Date().toISOString(),
      checks: { database, redis },
    });
  };

  const readySchema = {
    tags: ['health'],
    response: { 200: healthResponseSchema, 503: healthResponseSchema },
  };
  const noLimit = { rateLimit: false } as const;

  r.get(
    '/health',
    { schema: { tags: ['health'], response: { 200: livenessSchema } }, config: noLimit },
    async () => ({ status: 'ok' as const, version: API_VERSION }),
  );
  r.get('/ready', { schema: readySchema, config: noLimit }, (_req, reply) => ready(reply));
  r.get('/v1/health', { schema: readySchema, config: noLimit }, (_req, reply) => ready(reply));
}
