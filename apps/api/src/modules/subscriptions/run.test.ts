import { toManilaParts } from '@ebalangay/shared';
import { describe, expect, it } from 'vitest';
import { nextRunAfter } from './run.js';

const DAY = 86_400_000;

describe('nextRunAfter', () => {
  const t = new Date('2026-11-20T01:30:00Z');

  it.each([
    ['daily', 1],
    ['weekly', 7],
    ['biweekly', 14],
  ])('%s adds fixed days', (cadence, days) => {
    expect(nextRunAfter(t, cadence).getTime()).toBe(t.getTime() + days * DAY);
  });

  it('monthly keeps the Manila day and time', () => {
    // 2026-02-01 00:30 Manila (still Jan 31 in UTC).
    const r = nextRunAfter(new Date('2026-01-31T16:30:00Z'), 'monthly');
    expect(r.toISOString()).toBe('2026-02-28T16:30:00.000Z');
    expect(toManilaParts(r)).toMatchObject({ month: 3, day: 1, hour: 0, minute: 30 });
  });

  it('monthly clamps to the last day of a shorter month', () => {
    // Jan 31 09:00 Manila -> Feb 28 09:00 Manila.
    const r = nextRunAfter(new Date('2026-01-31T01:00:00Z'), 'monthly');
    expect(r.toISOString()).toBe('2026-02-28T01:00:00.000Z');
  });

  it('monthly rolls over the year', () => {
    const r = nextRunAfter(new Date('2026-12-15T02:00:00Z'), 'monthly');
    expect(r.toISOString()).toBe('2027-01-15T02:00:00.000Z');
  });

  it('rejects unknown cadences', () => {
    expect(() => nextRunAfter(t, 'hourly')).toThrow();
  });
});
