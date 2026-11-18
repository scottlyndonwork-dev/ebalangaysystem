import { z } from 'zod';
import { businessTypeSchema, documentStatusSchema, merchantStatusSchema } from '../enums.js';
import { merchantPermissionSchema, staffRolePresetSchema } from '../permissions.js';
import {
  basisPointsSchema,
  cursorPageQuerySchema,
  dateKeySchema,
  idSchema,
  latLngSchema,
  nonNegativeCentavosSchema,
  phPhoneSchema,
  timeOfDaySchema,
  timestampSchema,
  urlSchema,
} from './common.js';

// ---------------------------------------------------------------- hours & availability

export const storeHoursSlotSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  opensAt: timeOfDaySchema,
  /** Earlier than (or equal to) opensAt means the slot runs past midnight. */
  closesAt: timeOfDaySchema,
});
export type StoreHoursSlotInput = z.infer<typeof storeHoursSlotSchema>;

/** A holiday closure, or special hours (closed = false + opensAt/closesAt) for one Manila date. */
export const holidayClosureSchema = z
  .object({
    date: dateKeySchema,
    closed: z.boolean(),
    opensAt: timeOfDaySchema.nullable(),
    closesAt: timeOfDaySchema.nullable(),
    note: z.string().trim().max(120).nullable(),
  })
  .refine((h) => h.closed || (h.opensAt !== null && h.closesAt !== null), {
    message: 'Special hours need opensAt and closesAt',
    path: ['opensAt'],
  });
export type HolidayClosure = z.infer<typeof holidayClosureSchema>;

export const upsertHolidayInputSchema = z
  .object({
    closed: z.boolean(),
    opensAt: timeOfDaySchema.nullable().default(null),
    closesAt: timeOfDaySchema.nullable().default(null),
    note: z.string().trim().max(120).nullable().default(null),
  })
  .refine((h) => h.closed || (h.opensAt !== null && h.closesAt !== null), {
    message: 'Special hours need opensAt and closesAt',
    path: ['opensAt'],
  });
export type UpsertHolidayInput = z.infer<typeof upsertHolidayInputSchema>;

export const storeHoursSchema = z.object({
  merchantId: idSchema,
  weekly: z.array(storeHoursSlotSchema).max(28),
  /** Today and later, ascending. */
  holidays: z.array(holidayClosureSchema),
});
export type StoreHours = z.infer<typeof storeHoursSchema>;

export const setWeeklyHoursInputSchema = z.object({
  weekly: z.array(storeHoursSlotSchema).max(28),
});
export type SetWeeklyHoursInput = z.infer<typeof setWeeklyHoursInputSchema>;

export const closedReasonSchema = z.enum([
  'inactive',
  'paused',
  'auto_paused',
  'holiday',
  'outside_hours',
]);

/** Pause taking orders. Neither minutes nor until = paused until the merchant resumes. */
export const pauseStoreInputSchema = z
  .object({
    minutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60)
      .optional(),
    until: timestampSchema.optional(),
    message: z.string().trim().max(140).optional(),
  })
  .refine((p) => !(p.minutes && p.until), { message: 'Use minutes or until, not both' });
export type PauseStoreInput = z.infer<typeof pauseStoreInputSchema>;

// ---------------------------------------------------------------- merchant profile

export const merchantSchema = z.object({
  id: idSchema,
  slug: z.string().regex(/^[a-z0-9-]{3,60}$/),
  name: z.string().min(1).max(120),
  businessType: businessTypeSchema,
  status: merchantStatusSchema,
  description: z.string().max(1000).nullable(),
  logoUrl: urlSchema.nullable(),
  coverUrl: urlSchema.nullable(),
  phone: phPhoneSchema,
  addressLine: z.string().max(300),
  barangay: z.string().max(100),
  city: z.string().max(100),
  location: latLngSchema,
  zoneId: idSchema.nullable(),
  ratingAverage: z.number().min(0).max(5),
  ratingCount: z.number().int().nonnegative(),
  isOpen: z.boolean(),
  prepTimeMinutes: z.number().int().min(0).max(240),
  minOrderCentavos: nonNegativeCentavosSchema,
  commissionBps: basisPointsSchema,
  version: z.number().int().nonnegative(),
  createdAt: timestampSchema,
});
export type Merchant = z.infer<typeof merchantSchema>;

/** What the store's own staff see (merchant app / merchant web). */
export const merchantProfileSchema = merchantSchema.extend({
  email: z.email().nullable(),
  province: z.string().max(100),
  /** Null = platform default commission. */
  commissionBps: basisPointsSchema.nullable(),
  deliveryRadiusM: z.number().int().positive(),
  autoAccept: z.boolean(),
  advanceOrderHours: z.number().int().nonnegative(),
  freeDelivery: z.boolean(),
  verifiedBadge: z.boolean(),
  pausedUntil: timestampSchema.nullable(),
  pauseMessage: z.string().nullable(),
  autoPausedReason: z.string().nullable(),
  closedReason: closedReasonSchema.nullable(),
  closesInMinutes: z.number().int().nonnegative().nullable(),
  avgResponseSeconds: z.number().int().nonnegative().nullable(),
  followerCount: z.number().int().nonnegative(),
  applicationSubmittedAt: timestampSchema.nullable(),
  /** Admin's reason when the application was rejected. */
  applicationReviewNote: z.string().nullable(),
});
export type MerchantProfile = z.infer<typeof merchantProfileSchema>;

/** Public listing card: no commission or internal fields. */
export const merchantSummarySchema = merchantSchema
  .pick({
    id: true,
    slug: true,
    name: true,
    businessType: true,
    logoUrl: true,
    coverUrl: true,
    ratingAverage: true,
    ratingCount: true,
    isOpen: true,
    prepTimeMinutes: true,
    minOrderCentavos: true,
  })
  .extend({
    verifiedBadge: z.boolean(),
    freeDelivery: z.boolean(),
    closedReason: closedReasonSchema.nullable(),
    closesInMinutes: z.number().int().nonnegative().nullable(),
    /** Null when the caller sent no location. */
    distanceMeters: z.number().int().nonnegative().nullable(),
    /** Filled by checkout pricing (2B-4); null until then. */
    deliveryFeeCentavos: nonNegativeCentavosSchema.nullable(),
    etaMinutes: z.number().int().nonnegative().nullable(),
  });
export type MerchantSummary = z.infer<typeof merchantSummarySchema>;

/** Starts a merchant application (status draft); the caller becomes the owner. */
export const createMerchantInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  businessType: businessTypeSchema,
  phone: phPhoneSchema,
  email: z.email().max(254).optional(),
  description: z.string().trim().max(1000).optional(),
  addressLine: z.string().trim().min(1).max(300),
  barangay: z.string().trim().min(1).max(100),
  city: z.string().trim().min(1).max(100),
  province: z.string().trim().min(1).max(100).default('Agusan del Norte'),
  location: latLngSchema,
});
export type CreateMerchantInput = z.infer<typeof createMerchantInputSchema>;

export const updateMerchantInputSchema = createMerchantInputSchema
  .omit({ businessType: true, email: true })
  .extend({
    email: z.email().max(254).nullable(),
    prepTimeMinutes: z.number().int().min(0).max(240),
    minOrderCentavos: nonNegativeCentavosSchema,
    deliveryRadiusM: z.number().int().min(500).max(30_000),
    autoAccept: z.boolean(),
    /** Minimum lead time for scheduled orders (e.g. 24 for catering). */
    advanceOrderHours: z.number().int().min(0).max(72),
    freeDelivery: z.boolean(),
    /** From POST /uploads/image (purpose logo/cover). */
    logoFileKey: z.string().max(512).nullable(),
    coverFileKey: z.string().max(512).nullable(),
  })
  .partial();
export type UpdateMerchantInput = z.infer<typeof updateMerchantInputSchema>;

/** Stores the signed-in user works at (merchant app store picker). */
export const myMerchantSchema = z.object({
  id: idSchema,
  slug: z.string(),
  name: z.string(),
  status: merchantStatusSchema,
  logoUrl: urlSchema.nullable(),
  rolePreset: staffRolePresetSchema,
});
export type MyMerchant = z.infer<typeof myMerchantSchema>;

// ---------------------------------------------------------------- uploads & documents

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const documentContentTypeSchema = z.enum([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
export const imageContentTypeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp']);

export const requestDocumentUploadInputSchema = z.object({
  contentType: documentContentTypeSchema,
  sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
});
export type RequestDocumentUploadInput = z.infer<typeof requestDocumentUploadInputSchema>;

export const requestImageUploadInputSchema = z.object({
  purpose: z.enum(['logo', 'cover']),
  contentType: imageContentTypeSchema,
  sizeBytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
});
export type RequestImageUploadInput = z.infer<typeof requestImageUploadInputSchema>;

/** PUT the file to `url` with exactly `headers`, then confirm with `fileKey`. */
export const presignedUploadSchema = z.object({
  fileKey: z.string(),
  url: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: timestampSchema,
});
export type PresignedUpload = z.infer<typeof presignedUploadSchema>;

export const MerchantDocumentType = {
  DTI: 'dti',
  SEC: 'sec',
  BIR: 'bir',
  MAYORS_PERMIT: 'mayors_permit',
  FDA_LTP: 'fda_ltp',
  VALID_ID: 'valid_id',
  OTHER: 'other',
} as const;
export const merchantDocumentTypeSchema = z.enum([
  'dti',
  'sec',
  'bir',
  'mayors_permit',
  'fda_ltp',
  'valid_id',
  'other',
]);
export type MerchantDocumentType = z.infer<typeof merchantDocumentTypeSchema>;

/** Every group must be satisfied (any one type in the group) before an application is submitted. */
export const REQUIRED_MERCHANT_DOCUMENTS: readonly (readonly MerchantDocumentType[])[] = [
  ['valid_id'],
  ['mayors_permit'],
  ['dti', 'sec'],
];

/** Required groups not covered by `types`, e.g. [["dti","sec"]]. */
export function missingMerchantDocuments(
  types: readonly string[],
): (readonly MerchantDocumentType[])[] {
  return REQUIRED_MERCHANT_DOCUMENTS.filter((group) => !group.some((t) => types.includes(t)));
}

export const addMerchantDocumentInputSchema = z.object({
  type: merchantDocumentTypeSchema,
  fileKey: z.string().min(1).max(512),
  /** Permit/ID expiry date, Manila. */
  expiresOn: dateKeySchema.optional(),
});
export type AddMerchantDocumentInput = z.infer<typeof addMerchantDocumentInputSchema>;

export const merchantDocumentSchema = z.object({
  id: idSchema,
  type: merchantDocumentTypeSchema,
  status: documentStatusSchema,
  notes: z.string().nullable(),
  expiresAt: timestampSchema.nullable(),
  reviewedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type MerchantDocument = z.infer<typeof merchantDocumentSchema>;

// ---------------------------------------------------------------- staff

export const merchantStaffSchema = z.object({
  id: idSchema,
  merchantId: idSchema,
  userId: idSchema,
  displayName: z.string().max(120),
  rolePreset: staffRolePresetSchema,
  permissions: z.array(merchantPermissionSchema),
  isActive: z.boolean(),
  /** Staff member's sign-in number, visible to staff managers. */
  phone: phPhoneSchema.nullable().optional(),
  createdAt: timestampSchema,
});
export type MerchantStaff = z.infer<typeof merchantStaffSchema>;

export const inviteStaffInputSchema = z.object({
  phone: phPhoneSchema,
  displayName: z.string().trim().min(1).max(120),
  rolePreset: staffRolePresetSchema,
  /** Defaults to the preset's permissions. */
  permissions: z.array(merchantPermissionSchema).optional(),
});
export type InviteStaffInput = z.infer<typeof inviteStaffInputSchema>;

export const updateStaffInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    rolePreset: staffRolePresetSchema,
    /** Replaces the list. Changing rolePreset without this resets to the preset's permissions. */
    permissions: z.array(merchantPermissionSchema),
    isActive: z.boolean(),
  })
  .partial();
export type UpdateStaffInput = z.infer<typeof updateStaffInputSchema>;

// ---------------------------------------------------------------- followers

export const followStatusSchema = z.object({
  following: z.boolean(),
  followerCount: z.number().int().nonnegative(),
});
export type FollowStatus = z.infer<typeof followStatusSchema>;

export const followedStoreSchema = z.object({
  merchantId: idSchema,
  slug: z.string(),
  name: z.string(),
  logoUrl: urlSchema.nullable(),
  followedAt: timestampSchema,
});
export type FollowedStore = z.infer<typeof followedStoreSchema>;

// ---------------------------------------------------------------- admin review

export const merchantApplicationSchema = z.object({
  id: idSchema,
  slug: z.string(),
  name: z.string(),
  businessType: businessTypeSchema,
  status: merchantStatusSchema,
  phone: phPhoneSchema,
  barangay: z.string(),
  city: z.string(),
  documentCount: z.number().int().nonnegative(),
  applicationSubmittedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type MerchantApplication = z.infer<typeof merchantApplicationSchema>;

export const listMerchantApplicationsQuerySchema = cursorPageQuerySchema.extend({
  cursor: idSchema.optional(),
  status: merchantStatusSchema.default('pending_review'),
});

export const adminMerchantDetailSchema = z.object({
  merchant: merchantProfileSchema,
  documents: z.array(merchantDocumentSchema),
  owners: z.array(
    z.object({ userId: idSchema, displayName: z.string(), phone: phPhoneSchema.nullable() }),
  ),
});
export type AdminMerchantDetail = z.infer<typeof adminMerchantDetailSchema>;

export const reviewDocumentInputSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  notes: z.string().trim().max(500).optional(),
});
export type ReviewDocumentInput = z.infer<typeof reviewDocumentInputSchema>;

export const rejectApplicationInputSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type RejectApplicationInput = z.infer<typeof rejectApplicationInputSchema>;

export const signedDownloadSchema = z.object({ url: z.string(), expiresAt: timestampSchema });
export type SignedDownload = z.infer<typeof signedDownloadSchema>;
