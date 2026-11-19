import { OrderStatus, OrderType, type ValueOf, zEnum } from './enums.js';

/**
 * The ONE order state machine. Apps request transitions; apps/api validates every status change
 * with `canTransition` before writing it. Apps may use it only to decide which buttons to show.
 */

export const OrderActor = {
  CUSTOMER: 'customer',
  MERCHANT: 'merchant',
  RIDER: 'rider',
  SYSTEM: 'system',
  ADMIN: 'admin',
} as const;
export type OrderActor = ValueOf<typeof OrderActor>;
export const orderActorSchema = zEnum(OrderActor);

export interface OrderTransition {
  from: OrderStatus;
  to: OrderStatus;
  actors: readonly OrderActor[];
  /** If set, the transition is only valid for these order types. */
  orderTypes?: readonly OrderType[];
}

export interface TransitionContext {
  /** Defaults to `regular` (a delivery order). */
  orderType?: OrderType;
}

const S = OrderStatus;
const { CUSTOMER, MERCHANT, RIDER, SYSTEM, ADMIN } = OrderActor;

/** Order types fulfilled by a rider. POS orders are handed over at the counter. */
export const DELIVERY_ORDER_TYPES: readonly OrderType[] = Object.values(OrderType).filter(
  (t) => t !== OrderType.POS,
);
const POS_ONLY: readonly OrderType[] = [OrderType.POS];

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [S.DELIVERED, S.CANCELLED, S.FAILED];

/**
 * Rider re-assignment does not change status: the order stays where it is while dispatch finds
 * another rider. If dispatch gives up, the system moves the order to `failed`.
 */
export const ORDER_TRANSITIONS: readonly OrderTransition[] = [
  // Payment
  { from: S.PENDING_PAYMENT, to: S.PLACED, actors: [SYSTEM] },
  { from: S.PENDING_PAYMENT, to: S.CANCELLED, actors: [CUSTOMER, SYSTEM, ADMIN] },
  { from: S.PENDING_PAYMENT, to: S.FAILED, actors: [SYSTEM] },

  // Merchant acceptance (system = auto-accept)
  { from: S.PLACED, to: S.CONFIRMED, actors: [MERCHANT, SYSTEM] },
  { from: S.PLACED, to: S.CANCELLED, actors: [CUSTOMER, MERCHANT, SYSTEM, ADMIN] },

  // Preparation
  { from: S.CONFIRMED, to: S.PREPARING, actors: [MERCHANT] },
  { from: S.PREPARING, to: S.READY, actors: [MERCHANT] },
  { from: S.READY, to: S.DELIVERED, actors: [MERCHANT], orderTypes: POS_ONLY },

  // Dispatch can assign a rider any time after confirmation.
  {
    from: S.CONFIRMED,
    to: S.RIDER_ASSIGNED,
    actors: [SYSTEM, ADMIN],
    orderTypes: DELIVERY_ORDER_TYPES,
  },
  {
    from: S.PREPARING,
    to: S.RIDER_ASSIGNED,
    actors: [SYSTEM, ADMIN],
    orderTypes: DELIVERY_ORDER_TYPES,
  },
  {
    from: S.READY,
    to: S.RIDER_ASSIGNED,
    actors: [SYSTEM, ADMIN],
    orderTypes: DELIVERY_ORDER_TYPES,
  },

  // Delivery
  { from: S.RIDER_ASSIGNED, to: S.RIDER_AT_MERCHANT, actors: [RIDER] },
  { from: S.RIDER_AT_MERCHANT, to: S.PICKED_UP, actors: [RIDER] },
  { from: S.PICKED_UP, to: S.ON_THE_WAY, actors: [RIDER] },
  { from: S.ON_THE_WAY, to: S.RIDER_NEARBY, actors: [RIDER, SYSTEM] },
  { from: S.ON_THE_WAY, to: S.DELIVERED, actors: [RIDER, ADMIN] },
  { from: S.RIDER_NEARBY, to: S.DELIVERED, actors: [RIDER, ADMIN] },

  // Cancellation: customers until the order is ready (after preparing starts, Cancellation
  // Protection compensates the merchant); merchants until pickup.
  { from: S.CONFIRMED, to: S.CANCELLED, actors: [CUSTOMER, MERCHANT, ADMIN] },
  { from: S.PREPARING, to: S.CANCELLED, actors: [CUSTOMER, MERCHANT, ADMIN] },
  { from: S.READY, to: S.CANCELLED, actors: [MERCHANT, ADMIN] },
  { from: S.RIDER_ASSIGNED, to: S.CANCELLED, actors: [MERCHANT, ADMIN] },
  { from: S.RIDER_AT_MERCHANT, to: S.CANCELLED, actors: [MERCHANT, ADMIN] },

  // Failure: before pickup only system/admin; after pickup the rider can also report it.
  { from: S.CONFIRMED, to: S.FAILED, actors: [SYSTEM, ADMIN] },
  { from: S.PREPARING, to: S.FAILED, actors: [SYSTEM, ADMIN] },
  { from: S.READY, to: S.FAILED, actors: [SYSTEM, ADMIN] },
  { from: S.RIDER_ASSIGNED, to: S.FAILED, actors: [SYSTEM, ADMIN] },
  { from: S.RIDER_AT_MERCHANT, to: S.FAILED, actors: [SYSTEM, ADMIN] },
  { from: S.PICKED_UP, to: S.FAILED, actors: [RIDER, SYSTEM, ADMIN] },
  { from: S.ON_THE_WAY, to: S.FAILED, actors: [RIDER, SYSTEM, ADMIN] },
  { from: S.RIDER_NEARBY, to: S.FAILED, actors: [RIDER, SYSTEM, ADMIN] },
];

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function findTransition(from: OrderStatus, to: OrderStatus): OrderTransition | undefined {
  return ORDER_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

function permits(t: OrderTransition, actor: OrderActor, ctx: TransitionContext): boolean {
  if (!t.actors.includes(actor)) return false;
  return !t.orderTypes || t.orderTypes.includes(ctx.orderType ?? OrderType.REGULAR);
}

export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: OrderActor,
  ctx: TransitionContext = {},
): boolean {
  const t = findTransition(from, to);
  return t !== undefined && permits(t, actor, ctx);
}

/** Statuses `actor` may move an order to from `from`. Useful for showing action buttons. */
export function nextStatuses(
  from: OrderStatus,
  actor: OrderActor,
  ctx: TransitionContext = {},
): OrderStatus[] {
  return ORDER_TRANSITIONS.filter((t) => t.from === from && permits(t, actor, ctx)).map(
    (t) => t.to,
  );
}
