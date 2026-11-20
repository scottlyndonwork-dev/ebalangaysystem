import { z } from 'zod';
import type { Db, Tx } from '../../db.js';
import { loadSettings } from '../../lib/settings.js';

const minutes = z
  .number()
  .int()
  .min(1)
  .max(7 * 24 * 60);

/** Order-housekeeping knobs (platform_settings rows, snake_case keys). */
export const orderOpsSettingsSchema = z.object({
  /** Unpaid online orders are cancelled after this long. */
  paymentTimeoutMinutes: minutes,
  /** ASAP orders the merchant hasn't accepted are cancelled after this long. */
  merchantAcceptTimeoutMinutes: minutes,
  /** Scheduled orders still unaccepted this long after release are cancelled. */
  scheduledAcceptGraceMinutes: minutes,
  /** Accepted orders without a rider for this long raise an admin alert. */
  noRiderAlertMinutes: minutes,
  /** Release = scheduledFor − prep time − this buffer (time to find and send a rider). */
  scheduledDispatchBufferMinutes: z.number().int().min(0).max(240),
  /** Recurring orders are placed this far ahead of their run time. */
  subscriptionLeadMinutes: minutes,
});
export type OrderOpsSettings = z.infer<typeof orderOpsSettingsSchema>;

export const DEFAULT_ORDER_OPS_SETTINGS: OrderOpsSettings = {
  paymentTimeoutMinutes: 30,
  merchantAcceptTimeoutMinutes: 15,
  scheduledAcceptGraceMinutes: 10,
  noRiderAlertMinutes: 30,
  scheduledDispatchBufferMinutes: 10,
  subscriptionLeadMinutes: 120,
};

export function loadOrderOpsSettings(db: Db | Tx): Promise<OrderOpsSettings> {
  return loadSettings(db, orderOpsSettingsSchema, DEFAULT_ORDER_OPS_SETTINGS);
}
