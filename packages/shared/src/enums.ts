export const UserRole = {
  CUSTOMER: 'customer',
  RIDER: 'rider',
  MERCHANT_STAFF: 'merchant_staff',
  ADMIN: 'admin',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const BusinessType = {
  RETAIL: 'retail',
  RESTAURANT: 'restaurant',
  SUPPLIER: 'supplier',
  WHOLESALER: 'wholesaler',
} as const;
export type BusinessType = (typeof BusinessType)[keyof typeof BusinessType];

export const WHOLESALE_BUSINESS_TYPES: readonly BusinessType[] = [
  BusinessType.SUPPLIER,
  BusinessType.WHOLESALER,
];

export const AppPlatform = {
  CUSTOMER: 'customer',
  RIDER: 'rider',
  MERCHANT: 'merchant',
  MERCHANT_WEB: 'merchant-web',
  ADMIN_WEB: 'admin-web',
} as const;
export type AppPlatform = (typeof AppPlatform)[keyof typeof AppPlatform];

export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  UPGRADE_REQUIRED: 'UPGRADE_REQUIRED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Header names shared by apps and API. */
export const Headers = {
  APP_VERSION: 'x-app-version',
  APP_PLATFORM: 'x-app-platform',
  REQUEST_ID: 'x-request-id',
} as const;
