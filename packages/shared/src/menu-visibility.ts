import { isOpenAt } from './time.js';

export interface MenuScheduleRule {
  dayOfWeek: number;
  /** "HH:mm" Manila; endTime <= startTime means the window runs past midnight. */
  startTime: string;
  endTime: string;
  productIds: readonly string[];
  categoryIds: readonly string[];
  isActive: boolean;
}

/** Does this schedule cover the product? Empty id lists = the whole menu. */
function covers(s: MenuScheduleRule, product: { id: string; categoryId: string | null }): boolean {
  if (s.productIds.length === 0 && s.categoryIds.length === 0) return true;
  return (
    s.productIds.includes(product.id) ||
    (product.categoryId !== null && s.categoryIds.includes(product.categoryId))
  );
}

/**
 * Menu scheduling at query time (Asia/Manila). A product no active schedule covers is always
 * visible; a covered product is visible only inside one of its covering windows.
 */
export function isVisibleOnMenu(
  product: { id: string; categoryId: string | null },
  schedules: readonly MenuScheduleRule[],
  now: Date = new Date(),
): boolean {
  const windows = schedules
    .filter((s) => s.isActive && covers(s, product))
    .map((s) => ({ dayOfWeek: s.dayOfWeek, opensAt: s.startTime, closesAt: s.endTime }));
  return windows.length === 0 || isOpenAt(windows, now);
}
