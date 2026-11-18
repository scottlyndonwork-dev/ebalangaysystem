import { describe, expect, it } from 'vitest';
import {
  type AvailabilityInput,
  INDEFINITE_PAUSE_UNTIL,
  storeAvailability,
} from './store-availability.js';

// 2026-03-02 is a Monday (dayOfWeek 1) in Manila. Manila = UTC+8.
const at = (manila: string) => new Date(`${manila}+08:00`);

const base: AvailabilityInput = {
  status: 'active',
  weekly: [
    { dayOfWeek: 1, opensAt: '08:00', closesAt: '12:00' },
    { dayOfWeek: 1, opensAt: '12:00', closesAt: '20:00' },
    { dayOfWeek: 2, opensAt: '18:00', closesAt: '02:00' },
  ],
  holidays: [],
  pausedUntil: null,
  autoPausedReason: null,
};

describe('storeAvailability', () => {
  it('is open inside weekly hours and merges back-to-back slots', () => {
    expect(storeAvailability(base, at('2026-03-02T11:00:00'))).toEqual({
      isOpen: true,
      closedReason: null,
      closesInMinutes: 9 * 60,
    });
  });

  it('is closed outside hours and at the exact closing minute', () => {
    expect(storeAvailability(base, at('2026-03-02T07:59:00')).closedReason).toBe('outside_hours');
    expect(storeAvailability(base, at('2026-03-02T20:00:00')).isOpen).toBe(false);
  });

  it('carries overnight slots past midnight', () => {
    const r = storeAvailability(base, at('2026-03-04T01:00:00')); // Wed 01:00, Tue slot
    expect(r).toMatchObject({ isOpen: true, closesInMinutes: 60 });
    expect(storeAvailability(base, at('2026-03-03T23:00:00')).closesInMinutes).toBe(180);
  });

  it('closes on a holiday, including the overnight tail of a closed day', () => {
    const holidays = [{ date: '2026-03-03', closed: true }];
    expect(storeAvailability({ ...base, holidays }, at('2026-03-03T19:00:00')).closedReason).toBe(
      'holiday',
    );
    expect(storeAvailability({ ...base, holidays }, at('2026-03-04T01:00:00')).isOpen).toBe(false);
  });

  it('uses special holiday hours instead of the weekly ones', () => {
    const holidays = [{ date: '2026-03-02', closed: false, opensAt: '10:00', closesAt: '14:00' }];
    const input = { ...base, holidays };
    expect(storeAvailability(input, at('2026-03-02T09:00:00')).isOpen).toBe(false);
    expect(storeAvailability(input, at('2026-03-02T13:00:00')).closesInMinutes).toBe(60);
  });

  it('honours pause, auto-pause and status', () => {
    const now = at('2026-03-02T11:00:00');
    expect(
      storeAvailability({ ...base, pausedUntil: at('2026-03-02T11:30:00') }, now).closedReason,
    ).toBe('paused');
    expect(storeAvailability({ ...base, pausedUntil: at('2026-03-02T10:00:00') }, now).isOpen).toBe(
      true,
    );
    expect(storeAvailability({ ...base, pausedUntil: INDEFINITE_PAUSE_UNTIL }, now).isOpen).toBe(
      false,
    );
    expect(
      storeAvailability({ ...base, autoPausedReason: 'key_product_sold_out' }, now).closedReason,
    ).toBe('auto_paused');
    expect(storeAvailability({ ...base, status: 'suspended' }, now).closedReason).toBe('inactive');
  });

  it('has no hours = always closed', () => {
    expect(storeAvailability({ ...base, weekly: [] }, at('2026-03-02T11:00:00')).isOpen).toBe(
      false,
    );
  });
});
