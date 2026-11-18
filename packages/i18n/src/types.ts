import type { en } from './en.js';

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

export const LOCALES = ['en', 'fil', 'ceb'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
