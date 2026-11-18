'use client';
import { type ReactNode, useEffect, useState } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { createI18n, type i18n, type Locale } from './index.js';

export { Trans, useTranslation } from 'react-i18next';

/** For React Native and Next.js client components. Create once at app start. */
export function createReactI18n(locale: Locale): i18n {
  return createI18n({ locale, plugins: [initReactI18next] });
}

/** Wrap the app; changing `locale` switches language without remounting. */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const [instance] = useState(() => createReactI18n(locale));
  useEffect(() => {
    if (instance.language !== locale) void instance.changeLanguage(locale);
  }, [instance, locale]);
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
