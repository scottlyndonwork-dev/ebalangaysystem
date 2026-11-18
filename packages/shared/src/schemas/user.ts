import { z } from 'zod';
import { userRoleSchema } from '../enums.js';
import { idSchema, localeSchema, phPhoneSchema, timestampSchema, urlSchema } from './common.js';

export const userSchema = z.object({
  id: idSchema,
  phone: phPhoneSchema,
  email: z.email().nullable(),
  firstName: z.string().min(1).max(80),
  lastName: z.string().max(80),
  avatarUrl: urlSchema.nullable(),
  roles: z.array(userRoleSchema).min(1),
  locale: localeSchema,
  createdAt: timestampSchema,
});
export type User = z.infer<typeof userSchema>;

export const updateProfileInputSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().max(80),
    email: z.email().nullable(),
    locale: localeSchema,
    avatarFileKey: z.string().max(512).nullable(),
  })
  .partial();
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;
