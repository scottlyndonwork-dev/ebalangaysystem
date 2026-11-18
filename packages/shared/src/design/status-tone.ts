import type { OrderStatus } from '../enums.js';

/** Visual tone for status pills; each UI package maps tones to its own classes. */
export type Tone = 'neutral' | 'info' | 'warning' | 'brand' | 'success' | 'danger';

export const ORDER_STATUS_TONE: Record<OrderStatus, Tone> = {
  pending_payment: 'warning',
  placed: 'info',
  confirmed: 'info',
  preparing: 'warning',
  ready: 'brand',
  rider_assigned: 'brand',
  rider_at_merchant: 'brand',
  picked_up: 'brand',
  on_the_way: 'brand',
  rider_nearby: 'brand',
  delivered: 'success',
  cancelled: 'neutral',
  failed: 'danger',
};
