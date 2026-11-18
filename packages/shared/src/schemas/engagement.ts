import { z } from 'zod';
import {
  notificationTypeSchema,
  reviewTargetSchema,
  storyMediaTypeSchema,
  ticketPrioritySchema,
  ticketStatusSchema,
  userRoleSchema,
} from '../enums.js';
import { cursorPageQuerySchema, idSchema, timestampSchema, urlSchema } from './common.js';

// Reviews
export const reviewSchema = z.object({
  id: idSchema,
  orderId: idSchema,
  authorId: idSchema,
  authorName: z.string(),
  target: reviewTargetSchema,
  targetId: idSchema,
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).nullable(),
  photoUrls: z.array(urlSchema).max(5),
  merchantReply: z.string().max(1000).nullable(),
  createdAt: timestampSchema,
});
export type Review = z.infer<typeof reviewSchema>;

export const createReviewInputSchema = z.object({
  orderId: idSchema,
  target: reviewTargetSchema,
  targetId: idSchema,
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
  photoFileKeys: z.array(z.string().max(512)).max(5).default([]),
});
export type CreateReviewInput = z.input<typeof createReviewInputSchema>;

export const replyReviewInputSchema = z.object({ reply: z.string().trim().min(1).max(1000) });

// Support tickets
export const ticketSchema = z.object({
  id: idSchema,
  code: z.string(),
  requesterId: idSchema,
  orderId: idSchema.nullable(),
  category: z.enum(['order', 'payment', 'refund', 'rider', 'merchant', 'account', 'other']),
  subject: z.string().max(160),
  status: ticketStatusSchema,
  priority: ticketPrioritySchema,
  assigneeId: idSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Ticket = z.infer<typeof ticketSchema>;

export const ticketMessageSchema = z.object({
  id: idSchema,
  ticketId: idSchema,
  authorId: idSchema,
  authorRole: userRoleSchema,
  body: z.string().max(4000),
  attachmentUrls: z.array(urlSchema).max(5),
  /** Internal notes are visible to admins only. */
  internal: z.boolean(),
  createdAt: timestampSchema,
});
export type TicketMessage = z.infer<typeof ticketMessageSchema>;

export const createTicketInputSchema = z.object({
  orderId: idSchema.optional(),
  category: ticketSchema.shape.category,
  subject: z.string().trim().min(3).max(160),
  body: z.string().trim().min(1).max(4000),
  attachmentFileKeys: z.array(z.string().max(512)).max(5).default([]),
});
export type CreateTicketInput = z.input<typeof createTicketInputSchema>;

export const replyTicketInputSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  attachmentFileKeys: z.array(z.string().max(512)).max(5).default([]),
  internal: z.boolean().default(false),
});
export type ReplyTicketInput = z.input<typeof replyTicketInputSchema>;

export const updateTicketInputSchema = z
  .object({
    status: ticketStatusSchema,
    priority: ticketPrioritySchema,
    assigneeId: idSchema.nullable(),
  })
  .partial();
export type UpdateTicketInput = z.infer<typeof updateTicketInputSchema>;

// Stories (merchant promos, 24h)
export const storySchema = z.object({
  id: idSchema,
  merchantId: idSchema,
  mediaType: storyMediaTypeSchema,
  mediaUrl: urlSchema,
  caption: z.string().max(200).nullable(),
  productId: idSchema.nullable(),
  viewCount: z.number().int().nonnegative(),
  expiresAt: timestampSchema,
  createdAt: timestampSchema,
});
export type Story = z.infer<typeof storySchema>;

export const createStoryInputSchema = z.object({
  mediaType: storyMediaTypeSchema,
  mediaFileKey: z.string().max(512),
  caption: z.string().trim().max(200).optional(),
  productId: idSchema.optional(),
});
export type CreateStoryInput = z.infer<typeof createStoryInputSchema>;

// Notifications
export const notificationSchema = z.object({
  id: idSchema,
  userId: idSchema,
  type: notificationTypeSchema,
  title: z.string().max(120),
  body: z.string().max(500),
  /** Deep-link payload, e.g. { orderId }. */
  data: z.record(z.string(), z.string()),
  readAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type Notification = z.infer<typeof notificationSchema>;

export const listNotificationsQuerySchema = cursorPageQuerySchema.extend({
  unreadOnly: z.stringbool().optional(),
});

export const markNotificationsReadInputSchema = z.object({
  ids: z.array(idSchema).min(1).max(100).optional(),
  all: z.boolean().optional(),
});
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadInputSchema>;

export const registerPushTokenInputSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().min(1).max(128),
});
export type RegisterPushTokenInput = z.infer<typeof registerPushTokenInputSchema>;
