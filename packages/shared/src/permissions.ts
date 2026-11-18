import { type ValueOf, zEnum } from './enums.js';

/** Fine-grained merchant staff permissions. The API checks these on every merchant-scoped route. */
export const MerchantPermission = {
  ORDERS_MANAGE: 'orders.manage',
  POS_USE: 'pos.use',
  CATALOG_EDIT: 'catalog.edit',
  INVENTORY_EDIT: 'inventory.edit',
  PROMOS_MANAGE: 'promos.manage',
  ANALYTICS_VIEW: 'analytics.view',
  FINANCE_VIEW: 'finance.view',
  STAFF_MANAGE: 'staff.manage',
  SETTINGS_EDIT: 'settings.edit',
} as const;
export type MerchantPermission = ValueOf<typeof MerchantPermission>;
export const merchantPermissionSchema = zEnum(MerchantPermission);

export const ALL_MERCHANT_PERMISSIONS: readonly MerchantPermission[] =
  Object.values(MerchantPermission);

export const StaffRolePreset = {
  OWNER: 'owner',
  MANAGER: 'manager',
  CASHIER: 'cashier',
  KITCHEN: 'kitchen',
} as const;
export type StaffRolePreset = ValueOf<typeof StaffRolePreset>;
export const staffRolePresetSchema = zEnum(StaffRolePreset);

const P = MerchantPermission;

/** Starting permission sets. Owners can customise any staff member's permissions afterwards. */
export const STAFF_ROLE_PRESETS: Record<StaffRolePreset, readonly MerchantPermission[]> = {
  owner: ALL_MERCHANT_PERMISSIONS,
  manager: [
    P.ORDERS_MANAGE,
    P.POS_USE,
    P.CATALOG_EDIT,
    P.INVENTORY_EDIT,
    P.PROMOS_MANAGE,
    P.ANALYTICS_VIEW,
  ],
  cashier: [P.ORDERS_MANAGE, P.POS_USE],
  kitchen: [P.ORDERS_MANAGE, P.INVENTORY_EDIT],
};

export function hasPermission(
  granted: readonly MerchantPermission[],
  required: MerchantPermission,
): boolean {
  return granted.includes(required);
}

export function hasAllPermissions(
  granted: readonly MerchantPermission[],
  required: readonly MerchantPermission[],
): boolean {
  return required.every((p) => granted.includes(p));
}
