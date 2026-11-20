/** All timestamps are stored in UTC; this is the display zone. */
export const DISPLAY_TIME_ZONE = 'Asia/Manila' as const;

/** Philippines has no DST, so the offset is fixed and these helpers need no Intl/tz data. */
export const MANILA_UTC_OFFSET_MINUTES = 8 * 60;
const OFFSET_MS = MANILA_UTC_OFFSET_MINUTES * 60_000;
const DAY_MS = 86_400_000;

type DateInput = Date | string | number;
const toDate = (d: DateInput): Date => (d instanceof Date ? d : new Date(d));

export interface ManilaParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  dayOfWeek: number;
}

export function toManilaParts(date: DateInput): ManilaParts {
  const t = toDate(date).getTime();
  if (Number.isNaN(t)) throw new RangeError('Invalid date');
  const m = new Date(t + OFFSET_MS);
  return {
    year: m.getUTCFullYear(),
    month: m.getUTCMonth() + 1,
    day: m.getUTCDate(),
    hour: m.getUTCHours(),
    minute: m.getUTCMinutes(),
    second: m.getUTCSeconds(),
    dayOfWeek: m.getUTCDay(),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" of the Manila calendar day containing `date`. */
export function manilaDateKey(date: DateInput): string {
  const p = toManilaParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** UTC instant of Manila midnight for the day containing `date`. */
export function startOfManilaDay(date: DateInput): Date {
  const shifted = toDate(date).getTime() + OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - OFFSET_MS);
}

export function addManilaDays(date: DateInput, days: number): Date {
  return new Date(toDate(date).getTime() + days * DAY_MS);
}

/** Convert a Manila wall-clock date ("YYYY-MM-DD") and time ("HH:mm") to a UTC Date. */
export function manilaWallTimeToUtc(dateKey: string, time = '00:00'): Date {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  const minutes = parseTimeOfDay(time);
  if (!dm) throw new RangeError(`Invalid date key: ${dateKey}`);
  const utc = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
  return new Date(utc + minutes * 60_000 - OFFSET_MS);
}

/** "HH:mm" (00:00-24:00) -> minutes since midnight. */
export function parseTimeOfDay(time: string): number {
  const m = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(time);
  const minutes = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  if (!m || minutes > 24 * 60) throw new RangeError(`Invalid time of day: ${time}`);
  return minutes;
}

export function minutesSinceManilaMidnight(date: DateInput): number {
  const p = toManilaParts(date);
  return p.hour * 60 + p.minute;
}

export interface StoreHoursSlot {
  dayOfWeek: number;
  /** "HH:mm" Manila time */
  opensAt: string;
  /** "HH:mm"; earlier than opensAt means the slot runs past midnight. */
  closesAt: string;
}

/** Is the store open at `date` (Manila time)? Overnight slots carry into the next day. */
export function isOpenAt(slots: readonly StoreHoursSlot[], date: DateInput): boolean {
  const { dayOfWeek } = toManilaParts(date);
  const now = minutesSinceManilaMidnight(date);
  const yesterday = (dayOfWeek + 6) % 7;
  return slots.some((s) => {
    const open = parseTimeOfDay(s.opensAt);
    const close = parseTimeOfDay(s.closesAt);
    const overnight = close <= open;
    if (s.dayOfWeek === dayOfWeek && now >= open && (overnight || now < close)) return true;
    return overnight && s.dayOfWeek === yesterday && now < close;
  });
}

/** Display only. Uses Intl; output varies slightly by runtime. */
export function formatManila(
  date: DateInput,
  locale = 'en-PH',
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: DISPLAY_TIME_ZONE }).format(
    toDate(date),
  );
}

const SHORT_DATE_TIME = new Intl.DateTimeFormat('en-PH', {
  timeZone: DISPLAY_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** e.g. "Nov 21, 10:30 AM" in Manila time, for push/SMS text params. */
export function formatManilaShort(date: DateInput): string {
  return SHORT_DATE_TIME.format(toDate(date));
}
