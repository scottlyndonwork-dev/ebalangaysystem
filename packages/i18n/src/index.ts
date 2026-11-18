import i18next, { type i18n, type Module, type TFunction } from 'i18next';
import { ceb } from './locales/ceb.js';
import { en } from './locales/en.js';
import { fil } from './locales/fil.js';
import {
  DEFAULT_LOCALE,
  LOCALES,
  type Locale,
  NAMESPACES,
  type Namespace,
  type Resources,
} from './types.js';

export { DEFAULT_LOCALE, LOCALES, NAMESPACES, type Locale, type Namespace, type Resources };
export type { i18n, TFunction };

export const resources: Record<Locale, Resources> = { en, fil, ceb };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Best supported locale for BCP-47 tags (device or Accept-Language), in preference order. */
export function pickLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const lang = tag.toLowerCase().split(/[-_]/)[0];
    if (lang === 'fil' || lang === 'tl') return 'fil';
    if (lang === 'ceb' || lang === 'bis') return 'ceb';
    if (lang === 'en') return 'en';
  }
  return DEFAULT_LOCALE;
}

export interface CreateI18nOptions {
  locale?: Locale;
  /** e.g. initReactI18next; see the ./react entry. */
  plugins?: Module[];
}

/** New, synchronously initialised i18next instance with all bundled resources. */
export function createI18n({
  locale = DEFAULT_LOCALE,
  plugins = [],
}: CreateI18nOptions = {}): i18n {
  const instance = i18next.createInstance();
  for (const plugin of plugins) instance.use(plugin);
  void instance.init({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...LOCALES],
    resources,
    ns: [...NAMESPACES],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return instance;
}
