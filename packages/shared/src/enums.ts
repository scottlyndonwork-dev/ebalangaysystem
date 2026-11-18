import { z } from 'zod';

/** Union of an `as const` object's values. */
export type ValueOf<T> = T[keyof T];

/** Zod enum over an `as const` object's VALUES (so .extract/.exclude take values like 'pos'). */
export function zEnum<const T extends Record<string, string>>(obj: T) {
  return z.enum(Object.values(obj) as [ValueOf<T>, ...ValueOf<T>[]]);
}

export const UserRole = {
  CUSTOMER: 'customer',
  RIDER: 'rider',
  MERCHANT_OWNER: 'merchant_owner',
  MERCHANT_STAFF: 'merchant_staff',
  ADMIN: 'admin',
  SUPER_ADMIN: 'super_admin',
} as const;
export type UserRole = ValueOf<typeof UserRole>;
export const userRoleSchema = zEnum(UserRole);

export const BusinessType = {
  RESTAURANT: 'restaurant',
  GROCERY: 'grocery',
  PHARMACY: 'pharmacy',
  RETAIL: 'retail',
  SUPPLIER: 'supplier',
  WHOLESALER: 'wholesaler',
} as const;
export type BusinessType = ValueOf<typeof BusinessType>;
export const businessTypeSchema = zEnum(BusinessType);

/** Wholesale features unlock by business type; there is no separate supplier portal. */
export const WHOLESALE_BUSINESS_TYPES: readonly BusinessType[] = [
  BusinessType.SUPPLIER,
  BusinessType.WHOLESALER,
];
export const isWholesaleBusiness = (t: BusinessType): boolean =>
  WHOLESALE_BUSINESS_TYPES.includes(t);

export const OrderStatus = {
  PENDING_PAYMENT: 'pending_payment',
  PLACED: 'placed',
  CONFIRMED: 'confirmed',
  PREPARING: 'preparing',
  READY: 'ready',
  RIDER_ASSIGNED: 'rider_assigned',
  RIDER_AT_MERCHANT: 'rider_at_merchant',
  PICKED_UP: 'picked_up',
  ON_THE_WAY: 'on_the_way',
  RIDER_NEARBY: 'rider_nearby',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} as const;
export type OrderStatus = ValueOf<typeof OrderStatus>;
export const orderStatusSchema = zEnum(OrderStatus);

export const OrderType = {
  REGULAR: 'regular',
  SCHEDULED: 'scheduled',
  GIFT: 'gift',
  GROUP: 'group',
  WHOLESALE: 'wholesale',
  SUBSCRIPTION: 'subscription',
  POS: 'pos',
} as const;
export type OrderType = ValueOf<typeof OrderType>;
export const orderTypeSchema = zEnum(OrderType);

export const PaymentMethod = {
  GCASH: 'gcash',
  MAYA: 'maya',
  CARD: 'card',
  BANCNET: 'bancnet',
  COD: 'cod',
  WALLET: 'wallet',
  POINTS: 'points',
} as const;
export type PaymentMethod = ValueOf<typeof PaymentMethod>;
export const paymentMethodSchema = zEnum(PaymentMethod);

export const PaymentStatus = {
  PENDING: 'pending',
  AWAITING_ACTION: 'awaiting_action',
  PAID: 'paid',
  FAILED: 'failed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
} as const;
export type PaymentStatus = ValueOf<typeof PaymentStatus>;
export const paymentStatusSchema = zEnum(PaymentStatus);

export const RiderStatus = {
  OFFLINE: 'offline',
  ONLINE: 'online',
  ON_DELIVERY: 'on_delivery',
} as const;
export type RiderStatus = ValueOf<typeof RiderStatus>;
export const riderStatusSchema = zEnum(RiderStatus);

export const RiderVerificationStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SUSPENDED: 'suspended',
} as const;
export type RiderVerificationStatus = ValueOf<typeof RiderVerificationStatus>;
export const riderVerificationStatusSchema = zEnum(RiderVerificationStatus);

export const VehicleType = {
  MOTORCYCLE: 'motorcycle',
  BICYCLE: 'bicycle',
  CAR: 'car',
  TRICYCLE: 'tricycle',
} as const;
export type VehicleType = ValueOf<typeof VehicleType>;
export const vehicleTypeSchema = zEnum(VehicleType);

export const MerchantStatus = {
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  REJECTED: 'rejected',
  DEACTIVATED: 'deactivated',
} as const;
export type MerchantStatus = ValueOf<typeof MerchantStatus>;
export const merchantStatusSchema = zEnum(MerchantStatus);

export const DocumentStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
} as const;
export type DocumentStatus = ValueOf<typeof DocumentStatus>;
export const documentStatusSchema = zEnum(DocumentStatus);

export const TicketStatus = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  AWAITING_CUSTOMER: 'awaiting_customer',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
} as const;
export type TicketStatus = ValueOf<typeof TicketStatus>;
export const ticketStatusSchema = zEnum(TicketStatus);

export const TicketPriority = {
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
} as const;
export type TicketPriority = ValueOf<typeof TicketPriority>;
export const ticketPrioritySchema = zEnum(TicketPriority);

export const PayoutStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  PAID: 'paid',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type PayoutStatus = ValueOf<typeof PayoutStatus>;
export const payoutStatusSchema = zEnum(PayoutStatus);

export const SettlementStatus = { OPEN: 'open', CLOSED: 'closed', PAID: 'paid' } as const;
export type SettlementStatus = ValueOf<typeof SettlementStatus>;
export const settlementStatusSchema = zEnum(SettlementStatus);

/** Merchant-side prep hints shown to customer and rider; does not change OrderStatus. */
export const PrepUpdate = {
  BEING_PACKED: 'being_packed',
  ALMOST_READY: 'almost_ready',
  RIDER_CALLED: 'rider_called',
} as const;
export type PrepUpdate = ValueOf<typeof PrepUpdate>;
export const prepUpdateSchema = zEnum(PrepUpdate);

export const DeliveryStatus = {
  SEARCHING: 'searching',
  OFFERED: 'offered',
  ASSIGNED: 'assigned',
  AT_MERCHANT: 'at_merchant',
  PICKED_UP: 'picked_up',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} as const;
export type DeliveryStatus = ValueOf<typeof DeliveryStatus>;
export const deliveryStatusSchema = zEnum(DeliveryStatus);

export const WalletTransactionType = {
  TOP_UP: 'top_up',
  PAYMENT: 'payment',
  REFUND: 'refund',
  CASHBACK: 'cashback',
  EARNING: 'earning',
  PAYOUT: 'payout',
  ADJUSTMENT: 'adjustment',
} as const;
export type WalletTransactionType = ValueOf<typeof WalletTransactionType>;
export const walletTransactionTypeSchema = zEnum(WalletTransactionType);

export const PointsTransactionType = {
  EARN: 'earn',
  REDEEM: 'redeem',
  EXPIRE: 'expire',
  ADJUSTMENT: 'adjustment',
} as const;
export type PointsTransactionType = ValueOf<typeof PointsTransactionType>;
export const pointsTransactionTypeSchema = zEnum(PointsTransactionType);

export const VoucherDiscountType = {
  FIXED: 'fixed',
  PERCENT: 'percent',
  FREE_DELIVERY: 'free_delivery',
} as const;
export type VoucherDiscountType = ValueOf<typeof VoucherDiscountType>;
export const voucherDiscountTypeSchema = zEnum(VoucherDiscountType);

export const VoucherFunding = { PLATFORM: 'platform', MERCHANT: 'merchant' } as const;
export type VoucherFunding = ValueOf<typeof VoucherFunding>;
export const voucherFundingSchema = zEnum(VoucherFunding);

export const ReviewTarget = { MERCHANT: 'merchant', RIDER: 'rider', PRODUCT: 'product' } as const;
export type ReviewTarget = ValueOf<typeof ReviewTarget>;
export const reviewTargetSchema = zEnum(ReviewTarget);

export const NotificationChannel = { PUSH: 'push', SMS: 'sms', IN_APP: 'in_app' } as const;
export type NotificationChannel = ValueOf<typeof NotificationChannel>;
export const notificationChannelSchema = zEnum(NotificationChannel);

export const NotificationType = {
  ORDER: 'order',
  PROMO: 'promo',
  WALLET: 'wallet',
  SUPPORT: 'support',
  SYSTEM: 'system',
} as const;
export type NotificationType = ValueOf<typeof NotificationType>;
export const notificationTypeSchema = zEnum(NotificationType);

export const StoryMediaType = { IMAGE: 'image', VIDEO: 'video' } as const;
export type StoryMediaType = ValueOf<typeof StoryMediaType>;
export const storyMediaTypeSchema = zEnum(StoryMediaType);

export const DayOfWeek = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 } as const;
export type DayOfWeek = ValueOf<typeof DayOfWeek>;

export const AppPlatform = {
  CUSTOMER: 'customer',
  RIDER: 'rider',
  MERCHANT: 'merchant',
  MERCHANT_WEB: 'merchant-web',
  ADMIN_WEB: 'admin-web',
} as const;
export type AppPlatform = ValueOf<typeof AppPlatform>;
export const appPlatformSchema = zEnum(AppPlatform);

/** Header names shared by apps and API. */
export const Headers = {
  APP_VERSION: 'x-app-version',
  APP_PLATFORM: 'x-app-platform',
  REQUEST_ID: 'x-request-id',
  IDEMPOTENCY_KEY: 'idempotency-key',
} as const;
