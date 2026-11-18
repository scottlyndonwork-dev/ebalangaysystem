import { describe, expect, it } from 'vitest';
import { isLocale, LOCALES, messages, t } from './index.js';

describe('i18n', () => {
  it('every locale has every key with a non-empty string', () => {
    const keys = Object.keys(messages.en);
    for (const locale of LOCALES) {
      expect(Object.keys(messages[locale]).sort()).toEqual([...keys].sort());
      for (const key of keys)
        expect(messages[locale][key as keyof typeof messages.en]).not.toBe('');
    }
  });

  it('translates and validates locales', () => {
    expect(t('fil', 'errors.FORBIDDEN')).toBe('Wala kang access dito.');
    expect(isLocale('ceb')).toBe(true);
    expect(isLocale('es')).toBe(false);
  });
});
