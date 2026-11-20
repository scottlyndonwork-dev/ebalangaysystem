import { describe, expect, it } from 'vitest';
import { type BadgeMetrics, DEFAULT_BADGE_SETTINGS, failedBadgeChecks } from './verified-badge.js';

const good: BadgeMetrics = {
  status: 'active',
  trustScore: 70,
  placed: 100,
  delivered: 30,
  merchantCancelled: 5,
  reviews: 10,
  rating: 4.5,
};
const check = (m: Partial<BadgeMetrics>) =>
  failedBadgeChecks({ ...good, ...m }, DEFAULT_BADGE_SETTINGS);

describe('failedBadgeChecks', () => {
  it('passes exactly at every threshold', () => {
    expect(check({})).toEqual([]);
  });

  it('flags each rule just past its threshold', () => {
    expect(check({ status: 'suspended' })).toEqual(['active']);
    expect(check({ delivered: 29 })).toEqual(['min_delivered']);
    expect(check({ merchantCancelled: 6 })).toEqual(['max_merchant_cancel']);
    expect(check({ reviews: 9 })).toEqual(['min_reviews']);
    expect(check({ rating: 4.49 })).toEqual(['min_rating']);
    expect(check({ rating: null, reviews: 0 })).toEqual(['min_reviews', 'min_rating']);
    expect(check({ trustScore: 69 })).toEqual(['min_trust_score']);
  });

  it('treats no orders as failing delivered but not the cancel rate', () => {
    expect(check({ placed: 0, delivered: 0, merchantCancelled: 0 })).toEqual(['min_delivered']);
  });
});
