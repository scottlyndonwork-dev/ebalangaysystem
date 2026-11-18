import { z } from 'zod';
import { businessTypeSchema, merchantStatusSchema } from '../enums.js';
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

export const storeHoursSlotSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  opensAt: timeOfDaySchema,
  /** Earlier than opensAt means the slot runs past midnight. */
  closesAt: timeOfDaySchema,
});

export const storeHoursExceptionSchema = z.object({
  date: dateKeySchema,
  closed: z.boolean(),
  slots: z.array(storeHoursSlotSchema.omit({ dayOfWeek: true })).max(4),
  note: z.string().max(120).nullable(),
});

export const storeHoursSchema = z.object({
  merchantId: idSchema,
  weekly: z.array(storeHoursSlotSchema).max(28),
  exceptions: z.array(storeHoursExceptionSchema).max(60),
  /** Merchant tapped "pause orders" until this time. */
  pausedUntil: timestampSchema.nullable(),
});
export type StoreHours = z.infer<typeof storeHoursSchema>;

export const updateStoreHoursInputSchema = storeHoursSchema.omit({ merchantId: true }).partial();
export type UpdateStoreHoursInput = z.infer<typeof updateStoreHoursInputSchema>;

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
    distanceMeters: z.number().int().nonnegative().nullable(),
    deliveryFeeCentavos: nonNegativeCentavosSchema.nullable(),
    etaMinutes: z.number().int().nonnegative().nullable(),
  });
export type MerchantSummary = z.infer<typeof merchantSummarySchema>;

export const createMerchantInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  businessType: businessTypeSchema,
  phone: phPhoneSchema,
  description: z.string().trim().max(1000).optional(),
  addressLine: z.string().trim().min(1).max(300),
  barangay: z.string().trim().min(1).max(100),
  city: z.string().trim().min(1).max(100),
  location: latLngSchema,
});
export type CreateMerchantInput = z.infer<typeof createMerchantInputSchema>;

export const updateMerchantInputSchema = createMerchantInputSchema
  .omit({ businessType: true })
  .extend({
    prepTimeMinutes: z.number().int().min(0).max(240),
    minOrderCentavos: nonNegativeCentavosSchema,
    logoFileKey: z.string().max(512).nullable(),
    coverFileKey: z.string().max(512).nullable(),
  })
  .partial();
export type UpdateMerchantInput = z.infer<typeof updateMerchantInputSchema>;

export const listMerchantsQuerySchema = cursorPageQuerySchema.extend({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  businessType: businessTypeSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  openNow: z.stringbool().optional(),
});
export type ListMerchantsQuery = z.infer<typeof listMerchantsQuerySchema>;

export const merchantStaffSchema = z.object({
  id: idSchema,
  merchantId: idSchema,
  userId: idSchema,
  displayName: z.string().max(120),
  rolePreset: staffRolePresetSchema,
  permissions: z.array(merchantPermissionSchema),
  isActive: z.boolean(),
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
