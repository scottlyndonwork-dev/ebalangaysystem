import { describe, expect, it } from 'vitest';
import { type MenuScheduleRule, isVisibleOnMenu } from './menu-visibility.js';

// 2026-03-02 is a Monday (dayOfWeek 1) in Manila.
const at = (manila: string) => new Date(`${manila}+08:00`);
const p = { id: 'p1', categoryId: 'c1' };
const rule = (r: Partial<MenuScheduleRule>): MenuScheduleRule => ({
  dayOfWeek: 1,
  startTime: '06:00',
  endTime: '10:30',
  productIds: [],
  categoryIds: [],
  isActive: true,
  ...r,
});

describe('isVisibleOnMenu', () => {
  it('no schedules = always visible', () => {
    expect(isVisibleOnMenu(p, [], at('2026-03-02T23:00:00'))).toBe(true);
  });

  it('whole-menu schedule hides everything outside its window', () => {
    const s = [rule({})];
    expect(isVisibleOnMenu(p, s, at('2026-03-02T07:00:00'))).toBe(true);
    expect(isVisibleOnMenu(p, s, at('2026-03-02T10:30:00'))).toBe(false);
    expect(isVisibleOnMenu(p, s, at('2026-03-03T07:00:00'))).toBe(false);
  });

  it('only covered products are restricted', () => {
    const s = [rule({ productIds: ['other'] })];
    expect(isVisibleOnMenu(p, s, at('2026-03-02T15:00:00'))).toBe(true);
    const byCat = [rule({ categoryIds: ['c1'] })];
    expect(isVisibleOnMenu(p, byCat, at('2026-03-02T15:00:00'))).toBe(false);
    expect(isVisibleOnMenu({ id: 'p2', categoryId: null }, byCat, at('2026-03-02T15:00:00'))).toBe(
      true,
    );
  });

  it('any covering window makes the product visible', () => {
    const s = [
      rule({ productIds: ['p1'] }),
      rule({ productIds: ['p1'], startTime: '17:00', endTime: '21:00' }),
    ];
    expect(isVisibleOnMenu(p, s, at('2026-03-02T18:00:00'))).toBe(true);
    expect(isVisibleOnMenu(p, s, at('2026-03-02T12:00:00'))).toBe(false);
  });

  it('overnight windows carry into the next day', () => {
    const s = [rule({ startTime: '22:00', endTime: '02:00' })];
    expect(isVisibleOnMenu(p, s, at('2026-03-02T23:00:00'))).toBe(true);
    expect(isVisibleOnMenu(p, s, at('2026-03-03T01:00:00'))).toBe(true);
    expect(isVisibleOnMenu(p, s, at('2026-03-03T03:00:00'))).toBe(false);
  });

  it('inactive schedules are ignored', () => {
    expect(isVisibleOnMenu(p, [rule({ isActive: false })], at('2026-03-02T15:00:00'))).toBe(true);
  });
});
