import { z } from 'zod';
import { appPlatformSchema } from '../enums.js';
import { phPhoneSchema, timestampSchema } from './common.js';
import { userSchema } from './user.js';

/** Apps that sign in with SMS OTP and keep tokens in secure storage. */
export const mobileAppPlatformSchema = z.enum(['customer', 'rider', 'merchant']);
export type MobileAppPlatform = z.infer<typeof mobileAppPlatformSchema>;

/** Browser apps: password (+ TOTP) login, session kept in httpOnly cookies. */
export const webAppPlatformSchema = z.enum(['merchant-web', 'admin-web']);
export type WebAppPlatform = z.infer<typeof webAppPlatformSchema>;

export const otpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

export const requestOtpInputSchema = z.object({ phone: phPhoneSchema });
export type RequestOtpInput = z.infer<typeof requestOtpInputSchema>;

export const requestOtpResponseSchema = z.object({
  expiresInSeconds: z.number().int().positive(),
  resendAfterSeconds: z.number().int().nonnegative(),
});
export type RequestOtpResponse = z.infer<typeof requestOtpResponseSchema>;

export const verifyOtpInputSchema = z.object({
  phone: phPhoneSchema,
  code: otpCodeSchema,
  platform: mobileAppPlatformSchema,
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

/** Mobile sends the refresh token in the body; web omits it and the httpOnly cookie is used. */
export const refreshTokenInputSchema = z.object({ refreshToken: z.string().min(1).optional() });
export type RefreshTokenInput = z.infer<typeof refreshTokenInputSchema>;

/** Web sessions: tokens are only ever in httpOnly cookies, never in the body. */
export const cookieSessionSchema = z.object({ accessTokenExpiresAt: timestampSchema });
export type CookieSession = z.infer<typeof cookieSessionSchema>;

/** Mobile gets new tokens; web gets fresh cookies and only the expiry. */
export const refreshResponseSchema = z.union([authTokensSchema, cookieSessionSchema]);
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

export const logoutInputSchema = z.object({ refreshToken: z.string().min(1).optional() });
export type LogoutInput = z.infer<typeof logoutInputSchema>;

/** merchant-web / admin-web. Identifier is an email or a +63 phone number. */
export const passwordLoginInputSchema = z.object({
  identifier: z.union([z.email().trim().toLowerCase(), phPhoneSchema]),
  password: z.string().min(1).max(256),
  platform: webAppPlatformSchema,
});
export type PasswordLoginInput = z.infer<typeof passwordLoginInputSchema>;

const mfaChallenge = {
  /** Short-lived, single-use token for the second step. Not a session. */
  mfaToken: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
};

export const loginResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('authenticated'),
    user: userSchema,
    accessTokenExpiresAt: timestampSchema,
  }),
  /** Enter the code from the authenticator app: POST /v1/auth/login/totp. */
  z.object({ status: z.literal('totp_required'), ...mfaChallenge }),
  /** Admins must enrol first: POST /v1/auth/totp/setup then /v1/auth/totp/enable. */
  z.object({ status: z.literal('totp_enrollment_required'), ...mfaChallenge }),
]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const totpLoginInputSchema = z.object({ mfaToken: z.string().min(1), code: otpCodeSchema });
export type TotpLoginInput = z.infer<typeof totpLoginInputSchema>;

/** Signed in: send nothing. Mid-login enrolment: send the mfaToken. */
export const totpSetupInputSchema = z.object({ mfaToken: z.string().min(1).optional() });
export type TotpSetupInput = z.infer<typeof totpSetupInputSchema>;

export const totpSetupResponseSchema = z.object({
  /** Base32 secret for manual entry. */
  secret: z.string(),
  /** otpauth:// URI to render as a QR code. */
  otpauthUrl: z.string(),
});
export type TotpSetupResponse = z.infer<typeof totpSetupResponseSchema>;

export const totpEnableInputSchema = z.object({
  code: otpCodeSchema,
  mfaToken: z.string().min(1).optional(),
});
export type TotpEnableInput = z.infer<typeof totpEnableInputSchema>;

export const totpDisableInputSchema = z.object({ code: otpCodeSchema });
export type TotpDisableInput = z.infer<typeof totpDisableInputSchema>;

export const devicePlatformSchema = z.enum(['ios', 'android', 'web']);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

export const registerDeviceInputSchema = z.object({
  deviceId: z.string().min(1).max(128),
  platform: devicePlatformSchema,
  app: appPlatformSchema,
  /** Expo push token; null clears it (e.g. notifications turned off). */
  pushToken: z.string().min(1).max(512).nullable().optional(),
  appVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional(),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceInputSchema>;

export const deviceSchema = z.object({
  deviceId: z.string(),
  platform: devicePlatformSchema,
  app: appPlatformSchema,
  hasPushToken: z.boolean(),
  lastSeenAt: timestampSchema,
});
export type Device = z.infer<typeof deviceSchema>;
