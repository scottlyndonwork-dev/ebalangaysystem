import type { RoomKind } from '@ebalangay/shared';

const root = ['ebalangay'] as const;
type Filters = Record<string, unknown>;

/**
 * Every TanStack Query key comes from here so invalidation (mutations, socket events,
 * reconnects) can target exactly the right cache entries.
 */
export const queryKeys = {
  all: root,
  health: () => [...root, 'health'] as const,
  me: () => [...root, 'me'] as const,
  orders: {
    all: () => [...root, 'orders'] as const,
    lists: () => [...root, 'orders', 'list'] as const,
    list: (filters: Filters = {}) => [...root, 'orders', 'list', filters] as const,
    detail: (id: string) => [...root, 'orders', 'detail', id] as const,
    chat: (id: string) => [...root, 'orders', 'detail', id, 'chat'] as const,
  },
  merchants: {
    all: () => [...root, 'merchants'] as const,
    list: (filters: Filters = {}) => [...root, 'merchants', 'list', filters] as const,
    detail: (id: string) => [...root, 'merchants', 'detail', id] as const,
  },
  products: {
    all: () => [...root, 'products'] as const,
    byMerchant: (merchantId: string, filters: Filters = {}) =>
      [...root, 'products', 'merchant', merchantId, filters] as const,
    detail: (id: string) => [...root, 'products', 'detail', id] as const,
  },
  cart: { all: () => [...root, 'cart'] as const },
  riders: {
    me: () => [...root, 'riders', 'me'] as const,
    jobs: () => [...root, 'riders', 'jobs'] as const,
  },
  wallet: {
    all: () => [...root, 'wallet'] as const,
    transactions: () => [...root, 'wallet', 'transactions'] as const,
  },
  notifications: { all: () => [...root, 'notifications'] as const },
  zones: { all: () => [...root, 'zones'] as const },
  admin: {
    all: () => [...root, 'admin'] as const,
    metrics: () => [...root, 'admin', 'metrics'] as const,
  },
};

export type QueryKey = readonly unknown[];

/** What to refetch after reconnecting to a room (events may have been missed). */
export function keysForRoom(kind: RoomKind, id: string | null): QueryKey[] {
  switch (kind) {
    case 'order':
      return id ? [queryKeys.orders.detail(id)] : [];
    case 'merchant':
      return id
        ? [queryKeys.orders.all(), queryKeys.merchants.detail(id), queryKeys.products.all()]
        : [];
    case 'user':
      return [
        queryKeys.me(),
        queryKeys.orders.lists(),
        queryKeys.notifications.all(),
        queryKeys.wallet.all(),
      ];
    case 'rider':
      return [queryKeys.riders.me(), queryKeys.riders.jobs(), queryKeys.orders.lists()];
    case 'zone':
      return [queryKeys.merchants.all(), queryKeys.cart.all()];
    case 'admin':
      return [queryKeys.admin.all()];
  }
}
