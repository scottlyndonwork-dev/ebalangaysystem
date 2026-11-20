import { weatherSurgeEventSchema, weatherTriggerSchema } from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { emitZoneSurge, WeatherReason, zoneSurgeBps } from '../weather/watcher.js';

const tags = ['admin-weather'];

type SurgeRow = {
  id: string;
  zoneId: string;
  ruleId: string | null;
  multiplierBps: number;
  reason: string | null;
  startsAt: Date;
  endsAt: Date | null;
};
const toEvent = (e: SurgeRow, zoneSurgeBps: number) => ({
  id: e.id,
  zoneId: e.zoneId,
  ruleId: e.ruleId,
  multiplierBps: e.multiplierBps,
  reason: e.reason,
  startsAt: e.startsAt.toISOString(),
  endsAt: e.endsAt?.toISOString() ?? null,
  zoneSurgeBps,
});

/**
 * Manual weather surges (PAGASA feed down or not wired, sudden local storm). Mounted inside
 * adminRoutes (IP allowlist + admin + TOTP); every change is audit-logged.
 */
export async function adminWeatherRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/weather/trigger',
    { schema: { tags, body: weatherTriggerSchema, response: { 201: weatherSurgeEventSchema } } },
    async (req, reply) => {
      const b = req.body;
      const now = new Date();
      const out = await app.db.$transaction(async (tx) => {
        const zone = await tx.zone.findFirst({ where: { id: b.zoneId, isActive: true } });
        if (!zone) throw new AppError('NOT_FOUND', 'zone not found');
        let multiplierBps = b.multiplierBps;
        if (b.ruleId) {
          const rule = await tx.surgeRule.findFirst({
            where: { id: b.ruleId, zoneId: b.zoneId, trigger: 'weather', isActive: true },
          });
          if (!rule) throw new AppError('NOT_FOUND', 'active weather rule not found in zone');
          multiplierBps = rule.multiplierBps;
        }
        const event = await tx.surgeEvent.create({
          data: {
            zoneId: b.zoneId,
            ruleId: b.ruleId ?? null,
            multiplierBps: multiplierBps as number,
            reason: WeatherReason.MANUAL,
            startsAt: now,
            endsAt: new Date(now.getTime() + b.durationMinutes * 60_000),
          },
        });
        await writeAudit(tx, req, {
          action: 'weather.surge.trigger',
          targetType: 'surge_event',
          targetId: event.id,
          metadata: {
            zoneId: b.zoneId,
            ruleId: b.ruleId ?? null,
            multiplierBps: event.multiplierBps,
            durationMinutes: b.durationMinutes,
            note: b.note,
          },
        });
        return toEvent(event, await emitZoneSurge(tx, b.zoneId, now));
      });
      return reply.code(201).send(out);
    },
  );

  r.post(
    '/weather/events/:eventId/end',
    {
      schema: {
        tags,
        params: z.object({ eventId: z.uuid() }),
        response: { 200: weatherSurgeEventSchema },
      },
    },
    async (req) => {
      const now = new Date();
      return app.db.$transaction(async (tx) => {
        const event = await tx.surgeEvent.findUnique({ where: { id: req.params.eventId } });
        if (!event?.reason?.startsWith('weather:'))
          throw new AppError('NOT_FOUND', 'weather surge not found');
        // Already over: nothing to change (idempotent).
        if (event.endsAt && event.endsAt <= now)
          return toEvent(event, await zoneSurgeBps(tx, event.zoneId, now));
        const ended = await tx.surgeEvent.update({
          where: { id: event.id },
          data: { endsAt: now },
        });
        await writeAudit(tx, req, {
          action: 'weather.surge.end',
          targetType: 'surge_event',
          targetId: event.id,
          metadata: { zoneId: event.zoneId, reason: event.reason },
        });
        return toEvent(ended, await emitZoneSurge(tx, event.zoneId, now));
      });
    },
  );
}
