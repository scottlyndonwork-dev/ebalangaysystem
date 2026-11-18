import {
  addManilaDays,
  manilaDateKey,
  minutesSinceManilaMidnight,
  parseTimeOfDay,
  type StoreHoursSlot,
  toManilaParts,
} from './time.js';

/** A holiday/special day. `closed: false` with hours = special hours that replace the weekly ones. */
export interface HolidayRule {
  /** "YYYY-MM-DD" Manila date */
  date: string;
  closed: boolean;
  opensAt?: string | null;
  closesAt?: string | null;
}

export interface AvailabilityInput {
  /** Only `active` stores can ever be open. */
  status: string;
  weekly: readonly StoreHoursSlot[];
  holidays: readonly HolidayRule[];
  pausedUntil: Date | string | null;
  /** Set by the system (e.g. a key product sold out). */
  autoPausedReason: string | null;
}

export type ClosedReason = 'inactive' | 'paused' | 'auto_paused' | 'holiday' | 'outside_hours';

export interface Availability {
  isOpen: boolean;
  closedReason: ClosedReason | null;
  /** Minutes until the current opening ends (contiguous slots are merged); null when closed. */
  closesInMinutes: number | null;
}

/** Stored as pausedUntil when a merchant pauses "until I resume". */
export const INDEFINITE_PAUSE_UNTIL = new Date('9999-12-31T00:00:00Z');

const DAY_MIN = 1440;

/** The opening slots that apply on one Manila date: a holiday rule replaces the weekly slots. */
function slotsForDate(
  input: AvailabilityInput,
  date: Date,
): { slots: { opensAt: string; closesAt: string }[]; holidayClosed: boolean } {
  const key = manilaDateKey(date);
  const holiday = input.holidays.find((h) => h.date === key);
  if (holiday) {
    if (holiday.closed) return { slots: [], holidayClosed: true };
    if (holiday.opensAt && holiday.closesAt) {
      return {
        slots: [{ opensAt: holiday.opensAt, closesAt: holiday.closesAt }],
        holidayClosed: false,
      };
    }
  }
  const dow = toManilaParts(date).dayOfWeek;
  return { slots: input.weekly.filter((s) => s.dayOfWeek === dow), holidayClosed: false };
}

/** Is the store taking orders at `now`, and for how much longer. All wall times are Manila. */
export function storeAvailability(input: AvailabilityInput, now: Date = new Date()): Availability {
  const closed = (closedReason: ClosedReason): Availability => ({
    isOpen: false,
    closedReason,
    closesInMinutes: null,
  });
  if (input.status !== 'active') return closed('inactive');
  if (input.autoPausedReason) return closed('auto_paused');
  if (input.pausedUntil && new Date(input.pausedUntil).getTime() > now.getTime()) {
    return closed('paused');
  }

  // Intervals in minutes relative to today's Manila midnight, for yesterday..tomorrow.
  const intervals: [number, number][] = [];
  let todayHolidayClosed = false;
  for (const offset of [-1, 0, 1]) {
    const { slots, holidayClosed } = slotsForDate(input, addManilaDays(now, offset));
    if (offset === 0) todayHolidayClosed = holidayClosed;
    for (const s of slots) {
      const open = parseTimeOfDay(s.opensAt);
      let close = parseTimeOfDay(s.closesAt);
      if (close <= open) close += DAY_MIN; // runs past midnight
      intervals.push([offset * DAY_MIN + open, offset * DAY_MIN + close]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const iv of intervals) {
    const last = merged.at(-1);
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([...iv]);
  }

  const nowMin = minutesSinceManilaMidnight(now);
  const current = merged.find(([start, end]) => nowMin >= start && nowMin < end);
  if (!current) return closed(todayHolidayClosed ? 'holiday' : 'outside_hours');
  return { isOpen: true, closedReason: null, closesInMinutes: current[1] - nowMin };
}
