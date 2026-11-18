import type { AppPlatform, User } from '@ebalangay/shared';
import type {
  AppPlatform as DbAppPlatform,
  User as DbUser,
} from '../../generated/prisma/client.js';

export {
  cookieSessionSchema,
  deviceSchema,
  loginResponseSchema,
  logoutInputSchema,
  passwordLoginInputSchema,
  refreshResponseSchema,
  refreshTokenInputSchema,
  registerDeviceInputSchema,
  requestOtpInputSchema,
  requestOtpResponseSchema,
  totpDisableInputSchema,
  totpEnableInputSchema,
  totpLoginInputSchema,
  totpSetupInputSchema,
  totpSetupResponseSchema,
  userSchema,
  verifyOtpInputSchema,
  verifyOtpResponseSchema,
} from '@ebalangay/shared';

// The DB enum can't hold "-", so merchant-web is stored as merchant_web (mapped in Prisma).
const TO_DB: Record<AppPlatform, DbAppPlatform> = {
  customer: 'customer',
  rider: 'rider',
  merchant: 'merchant',
  'merchant-web': 'merchant_web',
  'admin-web': 'admin_web',
};
const FROM_DB = Object.fromEntries(Object.entries(TO_DB).map(([k, v]) => [v, k])) as Record<
  DbAppPlatform,
  AppPlatform
>;
export const appToDb = (a: AppPlatform): DbAppPlatform => TO_DB[a];
export const appFromDb = (a: DbAppPlatform): AppPlatform => FROM_DB[a];

export const isWebApp = (a: AppPlatform) => a === 'merchant-web' || a === 'admin-web';

export function toUserDto(u: DbUser): User {
  return {
    id: u.id,
    phone: u.phone ?? '',
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    avatarUrl: u.avatarUrl,
    roles: u.roles,
    locale: u.locale,
    createdAt: u.createdAt.toISOString(),
  };
}
