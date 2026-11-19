import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import type { FastifyInstance } from 'fastify';
import { allQueues, type Queues } from '../workers/queues.js';
import { requireAdmin } from './auth.js';

export const BULL_BOARD_PATH = '/v1/admin/queues';

/**
 * Bull Board behind the same guard as /v1/admin (allowlisted IP, admin role, admin-web
 * session). Read-only: retry/clean/delete would be unaudited admin actions (RA 10173).
 * Register with `prefix: BULL_BOARD_PATH`.
 */
export async function bullBoardPlugin(
  app: FastifyInstance,
  { queues }: { queues: Queues },
): Promise<void> {
  const serverAdapter = new FastifyAdapter();
  createBullBoard({
    queues: allQueues(queues).map((q) => new BullMQAdapter(q, { readOnlyMode: true })),
    serverAdapter,
    options: { uiConfig: { boardTitle: 'eBalangay queues' } },
  });
  serverAdapter.setBasePath(BULL_BOARD_PATH);

  app.addHook('preHandler', requireAdmin());
  await app.register(serverAdapter.registerPlugin());
}
