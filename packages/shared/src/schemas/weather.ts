import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';

/** PAGASA rainfall warning colours, mildest first. */
export const rainfallWarningSchema = z.enum(['none', 'yellow', 'orange', 'red']);
export type RainfallWarning = z.infer<typeof rainfallWarningSchema>;
export const RAINFALL_LEVEL: Record<RainfallWarning, number> = {
  none: 0,
  yellow: 1,
  orange: 2,
  red: 3,
};

/** Current weather over one zone, as reported by the feed. */
export const weatherReadingSchema = z.object({
  zoneId: idSchema,
  rainfall: rainfallWarningSchema,
  /** Tropical Cyclone Wind Signal 0 (none) to 5. */
  cycloneSignal: z.number().int().min(0).max(5),
  observedAt: timestampSchema,
});
export type WeatherReading = z.infer<typeof weatherReadingSchema>;

/** `surge_rules.conditions` for trigger = weather: the rule fires when either threshold is met. */
export const weatherRuleConditionsSchema = z
  .object({
    minRainfall: rainfallWarningSchema.exclude(['none']).optional(),
    minCycloneSignal: z.number().int().min(1).max(5).optional(),
  })
  .refine((c) => c.minRainfall !== undefined || c.minCycloneSignal !== undefined, {
    message: 'set minRainfall and/or minCycloneSignal',
  });
export type WeatherRuleConditions = z.infer<typeof weatherRuleConditionsSchema>;

/** POST /v1/admin/weather/trigger: declare a weather surge by hand (feed down, local storm). */
export const weatherTriggerSchema = z
  .object({
    zoneId: idSchema,
    /** Use this weather rule's multiplier... */
    ruleId: idSchema.optional(),
    /** ...or an explicit one (10001 = just above 1x; pricing caps it at the max surge). */
    multiplierBps: z.number().int().min(10_001).max(50_000).optional(),
    durationMinutes: z
      .number()
      .int()
      .min(15)
      .max(12 * 60),
    note: z.string().trim().min(1).max(200),
  })
  .refine((b) => (b.ruleId === undefined) !== (b.multiplierBps === undefined), {
    message: 'give exactly one of ruleId or multiplierBps',
  });
export type WeatherTrigger = z.infer<typeof weatherTriggerSchema>;

export const weatherSurgeEventSchema = z.object({
  id: idSchema,
  zoneId: idSchema,
  ruleId: idSchema.nullable(),
  multiplierBps: z.number().int(),
  reason: z.string().nullable(),
  startsAt: timestampSchema,
  endsAt: timestampSchema.nullable(),
  /** The zone's resolved surge right after the change. */
  zoneSurgeBps: z.number().int(),
});
export type WeatherSurgeEvent = z.infer<typeof weatherSurgeEventSchema>;
