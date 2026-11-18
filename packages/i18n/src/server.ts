import { createI18n, type i18n, type Locale } from './index.js';

const cache = new Map<Locale, i18n>();

/**
 * Translator for server code (API push/SMS texts, Next.js server components).
 * One cached instance per locale; never call changeLanguage on it.
 */
export function getServerI18n(locale: Locale): i18n {
  let instance = cache.get(locale);
  if (!instance) {
    instance = createI18n({ locale });
    cache.set(locale, instance);
  }
  return instance;
}

export function getServerT(locale: Locale): i18n['t'] {
  return getServerI18n(locale).t;
}
