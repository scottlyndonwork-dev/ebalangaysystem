import { z } from 'zod';
import { orderStatusSchema, vehicleTypeSchema } from '../enums.js';
import { latLngSchema, timestampSchema } from './common.js';

/** Result of POST /v1/rider/location (and the socket `rider.location` ack). */
export const riderLocationResultSchema = z.object({
  /** Pings taken (too old, future-dated or already-seen pings are dropped). */
  accepted: z.number().int().nonnegative(),
  /** Orders the server just moved to rider_nearby. */
  nearbyOrderIds: z.array(z.uuid()),
});
export type RiderLocationResult = z.infer<typeof riderLocationResultSchema>;

/** Signed share link for an order; anyone holding the token can watch the delivery. */
export const trackingLinkSchema = z.object({
  token: z.string(),
  /** API path of the public tracking endpoint for this token. */
  path: z.string(),
  /** Null until the order ends (delivered/cancelled/failed); it then expires an hour later. */
  expiresAt: timestampSchema.nullable(),
});
export type TrackingLink = z.infer<typeof trackingLinkSchema>;

export const trackTokenParamsSchema = z.object({ token: z.string().min(20).max(80) });

/** GET /v1/track/:token. Deliberately thin: no names, phones or addresses beyond these. */
export const publicTrackingSchema = z.object({
  code: z.string(),
  status: orderStatusSchema,
  version: z.number().int().nonnegative(),
  etaAt: timestampSchema.nullable(),
  storeName: z.string(),
  storeLocation: latLngSchema,
  /** Null until a rider is assigned. */
  rider: z
    .object({
      firstName: z.string(),
      plateNumber: z.string().nullable(),
      vehicleType: vehicleTypeSchema,
      /** Live position while the rider is on the job; null otherwise or when unknown. */
      location: latLngSchema
        .extend({ heading: z.number().nullable(), updatedAt: timestampSchema })
        .nullable(),
    })
    .nullable(),
  updatedAt: timestampSchema,
});
export type PublicTracking = z.infer<typeof publicTrackingSchema>;
