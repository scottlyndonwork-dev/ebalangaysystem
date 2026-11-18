import { z } from 'zod';
import { idSchema, latLngSchema, phPhoneSchema, timestampSchema } from './common.js';

const addressFields = {
  label: z.string().trim().min(1).max(40),
  recipientName: z.string().trim().min(1).max(120),
  phone: phPhoneSchema,
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullable(),
  barangay: z.string().trim().min(1).max(100),
  city: z.string().trim().min(1).max(100),
  province: z.string().trim().min(1).max(100),
  postalCode: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  location: latLngSchema,
  deliveryNotes: z.string().trim().max(300).nullable(),
};

export const addressSchema = z.object({
  id: idSchema,
  userId: idSchema,
  ...addressFields,
  isDefault: z.boolean(),
  createdAt: timestampSchema,
});
export type Address = z.infer<typeof addressSchema>;

/** Point-in-time copy stored on an order so later address edits don't rewrite history. */
export const addressSnapshotSchema = z.object(addressFields);
export type AddressSnapshot = z.infer<typeof addressSnapshotSchema>;

export const createAddressInputSchema = z.object({
  ...addressFields,
  isDefault: z.boolean().default(false),
});
export type CreateAddressInput = z.infer<typeof createAddressInputSchema>;

export const updateAddressInputSchema = createAddressInputSchema.partial();
export type UpdateAddressInput = z.infer<typeof updateAddressInputSchema>;
