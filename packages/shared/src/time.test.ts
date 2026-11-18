import { describe, expect, it } from 'vitest';
import {
  addManilaDays,
  formatManila,
  isOpenAt,
  manilaDateKey,
  manilaWallTimeToUtc,
  minutesSinceManilaMidnight,
  parseTimeOfDay,
  startOfManilaDay,
  toManilaParts,
} from './time.js';

describe('Manila time', () => {
  it('shifts UTC to Manila (+08:00) across the date line', () => {
    // 2026-03-01T17:30Z is 2026-03-02 01:30 Monday in Manila.
    expect(toManilaParts('2026-03-01T17:30:00Z')).toEqual({
      year: 2026,
      month: 3,
      day: 2,
      hour: 1,
      minute: 30,
      second: 0,
      dayOfWeek: 1,
    });
    expect(manilaDateKey('2026-12-31T16:00:00Z')).toBe('2027-01-01');
    expect(minutesSinceManilaMidnight('2026-03-01T17:30:00Z')).toBe(90);
  });

  it('finds Manila midnight and converts wall time to UTC', () => {
    expect(startOfManilaDay('2026-03-01T17:30:00Z').toISOString()).toBe('2026-03-01T16:00:00.000Z');
    expect(manilaWallTimeToUtc('2026-03-02', '09:15').toISOString()).toBe(
      '2026-03-02T01:15:00.000Z',
    );
    expect(manilaWallTimeToUtc('2026-03-02').toISOString()).toBe('2026-03-01T16:00:00.000Z');
    expect(addManilaDays('2026-03-01T00:00:00Z', 2).toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });

  it('validates inputs', () => {
    expect(parseTimeOfDay('24:00')).toBe(1440);
    expect(() => parseTimeOfDay('24:01')).toThrow(RangeError);
    expect(() => parseTimeOfDay('9:00')).toThrow(RangeError);
    expect(() => manilaWallTimeToUtc('2026/03/02')).toThrow(RangeError);
    expect(() => toManilaParts('nope')).toThrow(RangeError);
  });

  it('formats in Asia/Manila', () => {
    expect(formatManila(new Date('2026-03-01T17:30:00Z'), 'en-US', { dateStyle: 'short' })).toBe(
      '3/2/26',
    );
  });
});

describe('isOpenAt', () => {
  // Monday 2026-03-02 in Manila.
  const at = (time: string, date = '2026-03-02') => manilaWallTimeToUtc(date, time);
  const hours = [
    { dayOfWeek: 1, opensAt: '08:00', closesAt: '20:00' },
    { dayOfWeek: 5, opensAt: '18:00', closesAt: '02:00' }, // Friday night until 2am Saturday
  ];

  it('handles same-day slots with exclusive close', () => {
    expect(isOpenAt(hours, at('07:59'))).toBe(false);
    expect(isOpenAt(hours, at('08:00'))).toBe(true);
    expect(isOpenAt(hours, at('19:59'))).toBe(true);
    expect(isOpenAt(hours, at('20:00'))).toBe(false);
    expect(isOpenAt(hours, at('12:00', '2026-03-03'))).toBe(false); // Tuesday
  });

  it('carries overnight slots into the next day', () => {
    expect(isOpenAt(hours, at('23:00', '2026-03-06'))).toBe(true); // Fri
    expect(isOpenAt(hours, at('01:30', '2026-03-07'))).toBe(true); // Sat early
    expect(isOpenAt(hours, at('02:00', '2026-03-07'))).toBe(false);
    expect(isOpenAt(hours, at('17:59', '2026-03-06'))).toBe(false);
  });
});
