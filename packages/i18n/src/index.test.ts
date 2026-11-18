import { ErrorCode } from '@ebalangay/shared';
import { describe, expect, it } from 'vitest';
import { createI18n, isLocale, LOCALES, NAMESPACES, pickLocale, resources } from './index.js';
import { getServerT } from './server.js';

type Tree = { [k: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([k, v]): [string, string][] =>
    typeof v === 'string' ? [[prefix + k, v]] : leaves(v, `${prefix}${k}.`),
  );
}
const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe('i18n resources', () => {
  const en = new Map(leaves(resources.en as unknown as Tree));

  it('has every namespace', () => {
    expect(Object.keys(resources.en).sort()).toEqual([...NAMESPACES].sort());
  });

  it.each(LOCALES)('%s has every key, non-empty, with matching placeholders', (locale) => {
    const entries = leaves(resources[locale] as unknown as Tree);
    expect(entries.map(([k]) => k).sort()).toEqual([...en.keys()].sort());
    for (const [key, value] of entries) {
      expect(value.trim(), key).not.toBe('');
      expect(placeholders(value), key).toEqual(placeholders(en.get(key) ?? ''));
    }
  });

  it('translates every API error code', () => {
    for (const code of Object.values(ErrorCode)) expect(resources.en.errors[code]).toBeTruthy();
  });
});

describe('i18n runtime', () => {
  it('translates with namespaces, interpolation and plurals', () => {
    const fil = createI18n({ locale: 'fil' });
    expect(fil.t('errors:FORBIDDEN')).toBe('Wala kang access dito.');
    expect(fil.t('auth:otpHint', { phone: '+639171234567' })).toBe(
      'Nagpadala kami ng code sa +639171234567.',
    );
    const en = createI18n();
    expect(en.t('orders:itemCount', { count: 1 })).toBe('1 item');
    expect(en.t('orders:itemCount', { count: 3 })).toBe('3 items');
    expect(en.t('tagline')).toBe('Need mo? eBalangay mo.');
  });

  it('server translator is cached per locale', () => {
    expect(getServerT('ceb')('orders:status.delivered')).toBe('Nahatod na');
    expect(getServerT('ceb')).toBe(getServerT('ceb'));
  });

  it('picks a supported locale', () => {
    expect(pickLocale(['tl-PH', 'en'])).toBe('fil');
    expect(pickLocale(['ceb'])).toBe('ceb');
    expect(pickLocale(['ja-JP', 'en-US'])).toBe('en');
    expect(pickLocale(['ja-JP'])).toBe('en');
    expect(isLocale('ceb')).toBe(true);
    expect(isLocale('es')).toBe(false);
  });
});
