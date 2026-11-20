import type { z } from 'zod';
import type { Db, Tx } from '../db.js';

const toKey = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Admin-tunable knobs: each field of `schema` is one `platform_settings` row (key = snake_case
 * of the field name, value = JSON); missing or invalid rows fall back to the default.
 */
export async function loadSettings<T extends Record<string, unknown>>(
  db: Db | Tx,
  schema: z.ZodObject<{ [K in keyof T]: z.ZodType<T[K]> }>,
  defaults: T,
): Promise<T> {
  const fields = Object.keys(defaults) as (keyof T & string)[];
  const rows = await db.platformSetting.findMany({
    where: { key: { in: fields.map(toKey) } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = { ...defaults };
  for (const f of fields) {
    const parsed = schema.shape[f].safeParse(byKey.get(toKey(f)));
    if (parsed.success) out[f] = parsed.data;
  }
  return out;
}
