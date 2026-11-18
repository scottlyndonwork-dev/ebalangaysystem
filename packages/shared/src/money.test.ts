import { describe, expect, it } from 'vitest';
import {
  addCentavos,
  allocateCentavos,
  applyBasisPoints,
  MoneyError,
  multiplyCentavos,
  pesosToCentavos,
} from './money.js';
import { compareVersions } from './version.js';

describe('pesosToCentavos', () => {
  it.each([
    ['0', 0],
    ['1', 100],
    ['1.5', 150],
    ['1.05', 105],
    ['1,234.56', 123456],
    ['-12.05', -1205],
    [' 0.1 ', 10],
  ])('%s -> %i', (input, expected) => {
    expect(pesosToCentavos(input)).toBe(expected);
  });

  it.each(['', 'abc', '1.234', '1.', '.5', '1e3'])('rejects %s', (input) => {
    expect(() => pesosToCentavos(input)).toThrow(MoneyError);
  });
});

describe('arithmetic', () => {
  it('adds and rejects non-integers', () => {
    expect(addCentavos(100, 250, -50)).toBe(300);
    expect(() => addCentavos(1.5)).toThrow(MoneyError);
  });

  it('multiplies by integer quantity', () => {
    expect(multiplyCentavos(1999, 3)).toBe(5997);
    expect(() => multiplyCentavos(100, 0.5)).toThrow(MoneyError);
  });

  it('applies basis points with half-up rounding', () => {
    expect(applyBasisPoints(10000, 1250)).toBe(1250);
    expect(applyBasisPoints(1, 5000)).toBe(1); // 0.5 -> 1
    expect(applyBasisPoints(3, 5000)).toBe(2); // 1.5 -> 2
    expect(applyBasisPoints(-3, 5000)).toBe(-2);
    expect(applyBasisPoints(999, 1)).toBe(0);
  });
});

describe('allocateCentavos', () => {
  it('splits evenly with leftover going first', () => {
    expect(allocateCentavos(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it('respects weights and always sums to total', () => {
    const parts = allocateCentavos(1001, [70, 20, 10]);
    expect(parts).toEqual([701, 200, 100]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1001);
  });

  it('handles negatives and zero weights', () => {
    expect(allocateCentavos(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocateCentavos(50, [0, 1])).toEqual([0, 50]);
  });

  it('rejects bad weights', () => {
    expect(() => allocateCentavos(100, [])).toThrow(MoneyError);
    expect(() => allocateCentavos(100, [0, 0])).toThrow(MoneyError);
    expect(() => allocateCentavos(100, [-1, 2])).toThrow(MoneyError);
  });
});

describe('compareVersions', () => {
  it('compares semver', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('0.9.0', '1.0.0')).toBe(-1);
  });
});
