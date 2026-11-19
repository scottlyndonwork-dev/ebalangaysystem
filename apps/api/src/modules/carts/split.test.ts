import { describe, expect, it } from 'vitest';
import { splitByWeight } from './quote.js';

const split = (total: number, weights: number[]) => [
  ...splitByWeight(
    total,
    weights.map((weight, i) => ({ id: String(i), weight })),
  ).values(),
];

describe('splitByWeight', () => {
  it('always sums to the total', () => {
    for (const [total, weights] of [
      [10_001, [1, 1, 1]],
      [99, [3, 0, 7]],
      [1, [5, 5]],
      [123_457, [10_000, 30_000, 1]],
    ] as const) {
      const parts = split(total, [...weights]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('is proportional and gives zero-weight members nothing', () => {
    expect(split(40_000, [10_000, 30_000, 0])).toEqual([10_000, 30_000, 0]);
    expect(split(10, [1, 1, 1])).toEqual([4, 3, 3]);
  });

  it('puts everything on the first member when nobody has items', () => {
    expect(split(500, [0, 0])).toEqual([500, 0]);
    expect(split(500, [])).toEqual([]);
  });

  it('handles totals and weights whose product overflows doubles', () => {
    expect(split(9_000_000_000, [9_000_000_000, 0])).toEqual([9_000_000_000, 0]);
  });
});
