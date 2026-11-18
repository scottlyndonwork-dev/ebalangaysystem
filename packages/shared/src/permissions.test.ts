import { describe, expect, it } from 'vitest';
import {
  ALL_MERCHANT_PERMISSIONS,
  hasAllPermissions,
  hasPermission,
  merchantPermissionSchema,
  STAFF_ROLE_PRESETS,
} from './permissions.js';

describe('merchant permissions', () => {
  it('owner preset has every permission', () => {
    expect([...STAFF_ROLE_PRESETS.owner].sort()).toEqual([...ALL_MERCHANT_PERMISSIONS].sort());
    expect(ALL_MERCHANT_PERMISSIONS).toHaveLength(9);
  });

  it('only owners manage staff, finance and settings', () => {
    for (const role of ['manager', 'cashier', 'kitchen'] as const) {
      for (const p of ['staff.manage', 'finance.view', 'settings.edit'] as const) {
        expect(hasPermission(STAFF_ROLE_PRESETS[role], p)).toBe(false);
      }
    }
  });

  it('cashier can use POS but not edit the catalog', () => {
    expect(hasAllPermissions(STAFF_ROLE_PRESETS.cashier, ['orders.manage', 'pos.use'])).toBe(true);
    expect(hasAllPermissions(STAFF_ROLE_PRESETS.cashier, ['pos.use', 'catalog.edit'])).toBe(false);
  });

  it('validates permission strings', () => {
    expect(merchantPermissionSchema.safeParse('pos.use').success).toBe(true);
    expect(merchantPermissionSchema.safeParse('pos.admin').success).toBe(false);
  });
});
