import type { en } from './locales/en.js';

export const LOCALES = ['en', 'fil', 'ceb'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export const NAMESPACES = [
  'common',
  'auth',
  'orders',
  'catalog',
  'errors',
  'notifications',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** Same shape as English with every leaf a string. */
type Stringify<T> = { [K in keyof T]: T[K] extends string ? string : Stringify<T[K]> };
export type Resources = Stringify<typeof en>;

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: typeof en;
  }
}
