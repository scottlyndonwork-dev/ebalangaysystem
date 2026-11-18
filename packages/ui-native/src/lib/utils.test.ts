import { describe, expect, it } from 'vitest';
import { clampQuantity, cn, initials, sanitizeOtp, starFills } from './utils.js';

describe('ui-native utils', () => {
  it('merges classes with later ones winning', () => {
    expect(cn('px-2 text-sm', false, 'px-4')).toBe('text-sm px-4');
  });

  it('sanitizes OTP input', () => {
    expect(sanitizeOtp('12 34-56789', 6)).toBe('123456');
    expect(sanitizeOtp('abc', 6)).toBe('');
  });

  it('clamps quantities', () => {
    expect(clampQuantity(5, 1, 3)).toBe(3);
    expect(clampQuantity(-1, 0, 3)).toBe(0);
    expect(clampQuantity(2.6, 1, 10)).toBe(3);
    expect(clampQuantity(Number.NaN, 1, 10)).toBe(1);
  });

  it('computes star fills to the nearest half', () => {
    expect(starFills(3.7)).toEqual(['full', 'full', 'full', 'half', 'empty']);
    expect(starFills(4.8)).toEqual(['full', 'full', 'full', 'full', 'full']);
    expect(starFills(-2)).toEqual(['empty', 'empty', 'empty', 'empty', 'empty']);
  });

  it('builds initials', () => {
    expect(initials('Juan Dela Cruz')).toBe('JC');
    expect(initials(' maria ')).toBe('M');
    expect(initials('')).toBe('');
  });
});
