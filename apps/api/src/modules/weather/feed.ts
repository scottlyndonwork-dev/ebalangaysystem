import { type WeatherReading, weatherReadingSchema } from '@ebalangay/shared';
import type { Logger } from 'pino';

/** Source of current weather per zone. `null` = no data this poll (leave surges alone). */
export interface WeatherFeed {
  readonly name: string;
  current(zoneIds: readonly string[], now: Date): Promise<WeatherReading[] | null>;
}

/**
 * PAGASA placeholder. PAGASA publishes rainfall warnings and cyclone wind signals per
 * area; mapping those areas onto our zones is not wired yet, so this reports no data and
 * weather surges come only from the admin trigger.
 */
export class PagasaWeatherFeed implements WeatherFeed {
  readonly name = 'pagasa';
  private warned = false;
  constructor(private readonly log?: Logger) {}

  current(): Promise<WeatherReading[] | null> {
    if (!this.warned) {
      this.warned = true;
      this.log?.info('PAGASA weather feed not wired; use POST /v1/admin/weather/trigger');
    }
    return Promise.resolve(null);
  }
}

/** Tests: set `readings` to what the next poll should see. */
export class MemoryWeatherFeed implements WeatherFeed {
  readonly name = 'memory';
  readings: WeatherReading[] | null = null;

  current(zoneIds: readonly string[]): Promise<WeatherReading[] | null> {
    return Promise.resolve(this.readings?.filter((r) => zoneIds.includes(r.zoneId)) ?? null);
  }
}

/** Drops malformed rows so one bad area never blocks the rest. */
export function validReadings(rows: readonly unknown[], log?: Logger): WeatherReading[] {
  const out: WeatherReading[] = [];
  for (const row of rows) {
    const r = weatherReadingSchema.safeParse(row);
    if (r.success) out.push(r.data);
    else log?.warn({ issues: r.error.issues }, 'invalid weather reading dropped');
  }
  return out;
}
