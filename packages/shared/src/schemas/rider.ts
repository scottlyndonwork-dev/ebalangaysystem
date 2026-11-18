import { z } from 'zod';
import {
  deliveryStatusSchema,
  riderStatusSchema,
  riderVerificationStatusSchema,
  vehicleTypeSchema,
} from '../enums.js';
import {
  basisPointsSchema,
  idSchema,
  latLngSchema,
  nonNegativeCentavosSchema,
  timestampSchema,
  urlSchema,
} from './common.js';

export const riderSchema = z.object({
  id: idSchema,
  userId: idSchema,
  displayName: z.string(),
  avatarUrl: urlSchema.nullable(),
  status: riderStatusSchema,
  verificationStatus: riderVerificationStatusSchema,
  vehicleType: vehicleTypeSchema,
  plateNumber: z.string().max(16).nullable(),
  zoneId: idSchema.nullable(),
  ratingAverage: z.number().min(0).max(5),
  ratingCount: z.number().int().nonnegative(),
  lastSeenAt: timestampSchema.nullable(),
});
export type Rider = z.infer<typeof riderSchema>;

/** What a customer sees about their rider. */
export const riderPublicSchema = riderSchema.pick({
  id: true,
  displayName: true,
  avatarUrl: true,
  vehicleType: true,
  plateNumber: true,
  ratingAverage: true,
});
export type RiderPublic = z.infer<typeof riderPublicSchema>;

export const setRiderStatusInputSchema = z.object({
  status: riderStatusSchema.exclude(['on_delivery']),
  location: latLngSchema.optional(),
});
export type SetRiderStatusInput = z.infer<typeof setRiderStatusInputSchema>;

export const riderLocationPingSchema = latLngSchema.extend({
  heading: z.number().min(0).max(360).nullable(),
  speedMps: z.number().min(0).max(100).nullable(),
  accuracyM: z.number().min(0).max(10_000).nullable(),
  recordedAt: timestampSchema,
});
export type RiderLocationPing = z.infer<typeof riderLocationPingSchema>;

/** Batched upload from the rider app; only breadcrumbs are persisted. */
export const riderLocationBatchInputSchema = z.object({
  pings: z.array(riderLocationPingSchema).min(1).max(100),
});
export type RiderLocationBatchInput = z.infer<typeof riderLocationBatchInputSchema>;

export const deliverySchema = z.object({
  id: idSchema,
  orderId: idSchema,
  riderId: idSchema.nullable(),
  status: deliveryStatusSchema,
  pickupLocation: latLngSchema,
  dropoffLocation: latLngSchema,
  distanceMeters: z.number().int().nonnegative(),
  riderFeeCentavos: nonNegativeCentavosSchema,
  /** COD amount the rider must collect, 0 when prepaid. */
  collectCentavos: nonNegativeCentavosSchema,
  offeredAt: timestampSchema.nullable(),
  assignedAt: timestampSchema.nullable(),
  pickedUpAt: timestampSchema.nullable(),
  deliveredAt: timestampSchema.nullable(),
  proofPhotoUrl: urlSchema.nullable(),
});
export type Delivery = z.infer<typeof deliverySchema>;

export const jobOfferSchema = z.object({
  deliveryId: idSchema,
  orderId: idSchema,
  merchantName: z.string(),
  pickupLocation: latLngSchema,
  dropoffLocation: latLngSchema,
  distanceMeters: z.number().int().nonnegative(),
  riderFeeCentavos: nonNegativeCentavosSchema,
  collectCentavos: nonNegativeCentavosSchema,
  expiresAt: timestampSchema,
});
export type JobOffer = z.infer<typeof jobOfferSchema>;

export const respondJobOfferInputSchema = z.object({
  accept: z.boolean(),
  declineReason: z.string().max(200).optional(),
});
export type RespondJobOfferInput = z.infer<typeof respondJobOfferInputSchema>;

export const completeDeliveryInputSchema = z.object({
  proofFileKey: z.string().max(512).optional(),
  collectedCentavos: nonNegativeCentavosSchema.optional(),
  version: z.number().int().nonnegative(),
});
export type CompleteDeliveryInput = z.infer<typeof completeDeliveryInputSchema>;

/** Closed ring: first point repeated as last. */
export const polygonSchema = z
  .array(latLngSchema)
  .min(4)
  .max(500)
  .refine((ring) => {
    const a = ring[0];
    const b = ring[ring.length - 1];
    return a !== undefined && b !== undefined && a.lat === b.lat && a.lng === b.lng;
  }, 'Polygon ring must be closed');

export const zoneSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  city: z.string().max(100),
  province: z.string().max(100),
  polygon: polygonSchema,
  isActive: z.boolean(),
  baseDeliveryFeeCentavos: nonNegativeCentavosSchema,
  perKmFeeCentavos: nonNegativeCentavosSchema,
  /** 10000 = no surge. */
  surgeBps: basisPointsSchema.min(10_000),
  version: z.number().int().nonnegative(),
});
export type Zone = z.infer<typeof zoneSchema>;

export const upsertZoneInputSchema = zoneSchema.omit({ id: true, version: true }).extend({
  version: z.number().int().nonnegative().optional(),
});
export type UpsertZoneInput = z.infer<typeof upsertZoneInputSchema>;
