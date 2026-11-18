import { z } from 'zod';
import { appPlatformSchema } from '../enums.js';
import { phPhoneSchema, timestampSchema } from './common.js';
import { userSchema } from './user.js';

export const requestOtpInputSchema = z.object({ phone: phPhoneSchema });
export type RequestOtpInput = z.infer<typeof requestOtpInputSchema>;

export const requestOtpResponseSchema = z.object({
  expiresInSeconds: z.number().int().positive(),
  resendAfterSeconds: z.number().int().nonnegative(),
});
export type RequestOtpResponse = z.infer<typeof requestOtpResponseSchema>;

export const verifyOtpInputSchema = z.object({
  phone: phPhoneSchema,
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  platform: appPlatformSchema,
  deviceId: z.string().min(1).max(128).optional(),
});
export type VerifyOtpInput = z.infer<typeof verifyOtpInputSchema>;

/** Access token lives 15 min; refresh tokens rotate on every use. */
export const authTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: timestampSchema,
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

export const verifyOtpResponseSchema = z.object({
  tokens: authTokensSchema,
  user: userSchema,
  isNewUser: z.boolean(),
});
export type VerifyOtpResponse = z.infer<typeof verifyOtpResponseSchema>;

export const refreshTokenInputSchema = z.object({ refreshToken: z.string().min(1) });
export type RefreshTokenInput = z.infer<typeof refreshTokenInputSchema>;

export const logoutInputSchema = z.object({ refreshToken: z.string().min(1).optional() });
export type LogoutInput = z.infer<typeof logoutInputSchema>;
