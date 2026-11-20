import { notificationTypeSchema } from '@ebalangay/shared';
import { z } from 'zod';

/** Mobile apps that hold push tokens. */
export const pushAppSchema = z.enum(['customer', 'rider', 'merchant']);
export type PushApp = z.infer<typeof pushAppSchema>;

/**
 * `outbox_events.push`: who to notify and with which i18n keys. Texts are localized per
 * recipient at delivery time (user.locale), never at write time.
 */
export const outboxPushSchema = z.object({
  userIds: z.array(z.uuid()).min(1),
  titleKey: z.string().min(1),
  bodyKey: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  /** Preference category; defaults to `order`. */
  category: notificationTypeSchema.optional(),
  /** Only devices of this app get the push; omitted = every device of the user. */
  app: pushAppSchema.optional(),
  /** Same key for the same user is delivered once; defaults to the outbox event id. */
  dedupeKey: z.string().min(1).max(200).optional(),
  /** Critical alerts only: i18n key of an SMS sent alongside the push. */
  smsKey: z.string().min(1).optional(),
});
export type OutboxPush = z.infer<typeof outboxPushSchema>;

/** Job data on the notifications queue: the outbox push plus where it came from. */
export const pushJobSchema = outboxPushSchema.extend({
  eventId: z.uuid(),
  event: z.string(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});
export type PushJob = z.infer<typeof pushJobSchema>;
