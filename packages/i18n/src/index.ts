import { ceb } from './ceb.js';
import { en } from './en.js';
import { fil } from './fil.js';
import { DEFAULT_LOCALE, LOCALES, type Locale, type MessageKey, type Messages } from './types.js';

export { DEFAULT_LOCALE, LOCALES, type Locale, type MessageKey, type Messages };

export const messages: Record<Locale, Messages> = { en, fil, ceb };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Translate with `{name}` placeholder interpolation; falls back to English. */
export function t(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const template = messages[locale]?.[key] ?? messages[DEFAULT_LOCALE][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
