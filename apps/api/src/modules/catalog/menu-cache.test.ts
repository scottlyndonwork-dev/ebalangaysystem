import { describe, expect, it } from 'vitest';
import { boundariesAt } from './menu-cache.js';

const rule = (id: string, dayOfWeek: number, startTime: string, endTime: string) => ({
  id,
  merchantId: 'm',
  dayOfWeek,
  startTime,
  endTime,
});
// Manila wall clock → UTC (UTC+8, no DST). 2030-01-06 is a Sunday.
const manila = (iso: string) => new Date(`${iso}+08:00`);

describe('boundariesAt', () => {
  it('finds same-day starts and ends', () => {
    const s = [rule('a', 1, '06:00', '10:30')];
    expect(boundariesAt(s, manila('2030-01-07T06:00:00'))).toEqual([
      { scheduleId: 'a', merchantId: 'm', kind: 'start' },
    ]);
    expect(boundariesAt(s, manila('2030-01-07T10:30:00'))).toEqual([
      { scheduleId: 'a', merchantId: 'm', kind: 'end' },
    ]);
    expect(boundariesAt(s, manila('2030-01-08T06:00:00'))).toEqual([]);
  });

  it('ends overnight and 24:00 windows on the next day', () => {
    const s = [rule('late', 6, '22:00', '02:00'), rule('eve', 6, '18:00', '24:00')];
    expect(boundariesAt(s, manila('2030-01-06T02:00:00'))).toEqual([
      { scheduleId: 'late', merchantId: 'm', kind: 'end' },
    ]);
    expect(boundariesAt(s, manila('2030-01-06T00:00:00'))).toEqual([
      { scheduleId: 'eve', merchantId: 'm', kind: 'end' },
    ]);
    expect(boundariesAt(s, manila('2030-01-05T02:00:00'))).toEqual([]);
  });
});
