/// <reference types="node" />
import { palette, semanticColors } from '@ebalangay/shared/design';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { heatLevel } from './components/Charts.js';
import { matchesAccept, parseMoneyInput } from './components/Inputs.js';
import { ringToSvgPoints } from './components/MapZoneEditor.js';
import { toCsv } from './lib/utils.js';

describe('toCsv', () => {
  const cols = [
    { header: 'Name', value: (r: { name: string; total: number }) => r.name },
    { header: 'Total', value: (r: { name: string; total: number }) => r.total },
  ];

  it('quotes commas, quotes and newlines', () => {
    expect(toCsv([{ name: 'Lechon, "Best"', total: 100 }], cols)).toBe(
      'Name,Total\r\n"Lechon, ""Best""",100',
    );
  });

  it('neutralises spreadsheet formulas in text but keeps negative numbers', () => {
    expect(toCsv([{ name: '=HYPERLINK("x")', total: -5 }], cols)).toBe(
      `Name,Total\r\n"'=HYPERLINK(""x"")",-5`,
    );
  });
});

describe('inputs', () => {
  it('parses money input into centavos', () => {
    expect(parseMoneyInput('1,234.5')).toBe(123450);
    expect(parseMoneyInput('')).toBeNull();
    expect(parseMoneyInput('1.234')).toBeNull();
  });

  it('matches accept lists', () => {
    expect(matchesAccept({ name: 'a.PNG', type: 'image/png' }, 'image/*')).toBe(true);
    expect(matchesAccept({ name: 'menu.csv', type: '' }, '.csv,text/csv')).toBe(true);
    expect(matchesAccept({ name: 'a.exe', type: 'application/x-msdownload' }, 'image/*,.pdf')).toBe(
      false,
    );
    expect(matchesAccept({ name: 'a.exe', type: '' })).toBe(true);
  });

  it('buckets heatmap values', () => {
    expect([0, 1, 5, 10].map((v) => heatLevel(v, 10))).toEqual([0, 1, 2, 4]);
    expect(heatLevel(3, 0)).toBe(0);
  });

  it('projects a zone ring into the SVG box', () => {
    const ring = [
      { lat: 1, lng: 0 },
      { lat: 1, lng: 1 },
      { lat: 0, lng: 1 },
      { lat: 1, lng: 0 },
    ];
    expect(ringToSvgPoints(ring)).toBe('5.00,5.00 95.00,5.00 95.00,95.00 5.00,5.00');
    expect(ringToSvgPoints([])).toBe('');
  });
});

describe('styles.css', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const block = (selector: string) => {
    const m = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
    return Object.fromEntries(
      [...(m?.[1] ?? '').matchAll(/--([\w-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2]?.trim()]),
    );
  };
  const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

  it.each([
    [':root', 'light'],
    ['.dark', 'dark'],
  ] as const)('%s variables match the shared %s tokens', (selector, scheme) => {
    const vars = block(selector);
    for (const [key, hex] of Object.entries(semanticColors[scheme])) {
      expect(vars[kebab(key)]?.toLowerCase(), key).toBe(hex.toLowerCase());
    }
  });

  it('brand scale matches the shared palette', () => {
    for (const [step, hex] of Object.entries(palette.brand)) {
      expect(css.toLowerCase()).toContain(`--color-brand-${step}: ${hex.toLowerCase()};`);
    }
  });
});
