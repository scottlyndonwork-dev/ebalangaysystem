import type { Db } from '../../db.js';

/** Materialized views refreshed nightly (00:00 PHT). Each needs a unique index for CONCURRENTLY. */
export const ANALYTICS_VIEWS = ['mv_merchant_daily_sales'] as const;

/** CONCURRENTLY keeps the views readable during the refresh. */
export async function refreshAnalyticsViews(db: Db): Promise<{ views: string[]; ms: number }> {
  const started = Date.now();
  for (const view of ANALYTICS_VIEWS) {
    // Identifier from the constant list above, never from input.
    await db.$executeRawUnsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
  }
  return { views: [...ANALYTICS_VIEWS], ms: Date.now() - started };
}
