/** All timestamps are stored in UTC; this is the display zone. */
export const DISPLAY_TIME_ZONE = 'Asia/Manila' as const;

export function formatManila(
  date: Date | string,
  locale = 'en-PH',
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: DISPLAY_TIME_ZONE }).format(d);
}
