/** Commerce fixtures shared by cart/order tests: a zone of its own, stores, products, customers. */
import { randomUUID } from 'node:crypto';
import { ALL_MERCHANT_PERMISSIONS, type AppPlatform, type UserRole } from '@ebalangay/shared';
import { type buildTestApp, randomPhone } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;

export const ALWAYS_OPEN = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
  dayOfWeek: d,
  opensAt: '00:00',
  closesAt: '24:00',
}));

export interface StoreOpts {
  open?: boolean;
  minOrder?: bigint;
  autoAccept?: boolean;
  freeDelivery?: boolean;
  advanceOrderHours?: number;
  verified?: boolean;
  businessType?: 'restaurant' | 'supplier';
}

export interface ProductOpts {
  name?: string;
  price?: number;
  stock?: number;
  isKey?: boolean;
  variants?: { name: string; price: number }[];
  /** One group: min/max and options. */
  modifiers?: { min: number; max: number; options: { name: string; delta: number }[] };
  wholesale?: { minQty: number; price: number }[];
}

/** Narrow away undefined/null in tests (no non-null assertions). */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export function fixtures(getCtx: () => Ctx) {
  const db = () => getCtx().app.db;
  // A random spot per test file so zones from other files never overlap.
  const center = { lat: 6 + Math.random() * 10, lng: 119 + Math.random() * 6 };
  let zoneId = '';

  const tokenFor = (userId: string, roles: UserRole[], app: AppPlatform) =>
    getCtx().app.jwt.sign({ typ: 'access', sub: userId, roles, app, sid: randomUUID() });

  /** ~0.05° square zone around the centre: ₱49 base, ₱10/km. */
  async function zone() {
    const d = 0.05;
    const { lat, lng } = center;
    const z = await db().zone.create({
      data: {
        name: `fx-${randomUUID()}`,
        city: 'Test City',
        province: 'Test',
        boundaryGeojson: {
          type: 'Polygon',
          coordinates: [
            [
              [lng - d, lat - d],
              [lng + d, lat - d],
              [lng + d, lat + d],
              [lng - d, lat + d],
              [lng - d, lat - d],
            ],
          ],
        },
        baseDeliveryFeeCentavos: 4900n,
        perKmFeeCentavos: 1000n,
      },
    });
    zoneId = z.id;
    return z;
  }

  async function user(roles: UserRole[] = ['customer']) {
    return db().user.create({ data: { phone: randomPhone(), roles } });
  }

  /** Active store 200 m north of the centre, with an owner and a kitchen-only staff member. */
  async function store(o: StoreOpts = {}) {
    const owner = await user(['merchant_owner']);
    const kitchen = await user(['merchant_staff']);
    const m = await db().merchant.create({
      data: {
        slug: `fx-${randomUUID().slice(0, 8)}`,
        name: `Store ${randomUUID().slice(0, 4)}`,
        businessType: o.businessType ?? 'restaurant',
        status: 'active',
        phone: '+639171234567',
        addressLine: 'Test St',
        barangay: 'Test',
        city: 'Test City',
        province: 'Test',
        lat: center.lat + 200 / 111_320,
        lng: center.lng,
        zoneId,
        prepTimeMinutes: 15,
        minOrderCentavos: o.minOrder ?? 0n,
        autoAccept: o.autoAccept ?? false,
        freeDelivery: o.freeDelivery ?? false,
        advanceOrderHours: o.advanceOrderHours ?? 0,
        verifiedBadge: o.verified ?? false,
        ...(o.open === false ? {} : { storeHours: { create: ALWAYS_OPEN } }),
      },
    });
    await db().merchantStaff.createMany({
      data: [
        {
          merchantId: m.id,
          userId: owner.id,
          displayName: 'Owner',
          rolePreset: 'owner',
          permissions: [...ALL_MERCHANT_PERMISSIONS],
        },
        {
          merchantId: m.id,
          userId: kitchen.id,
          displayName: 'Kitchen',
          rolePreset: 'kitchen',
          permissions: [],
        },
      ],
    });
    return {
      merchant: m,
      merchantId: m.id,
      base: `/v1/merchants/${m.id}`,
      ownerId: owner.id,
      owner: tokenFor(owner.id, ['merchant_owner'], 'merchant'),
      kitchen: tokenFor(kitchen.id, ['merchant_staff'], 'merchant'),
      /** The owner shopping from the customer app (e.g. wholesale buying). */
      ownerAsBuyer: tokenFor(owner.id, ['merchant_owner'], 'customer'),
    };
  }

  async function product(merchantId: string, o: ProductOpts = {}) {
    const p = await db().product.create({
      data: {
        merchantId,
        name: o.name ?? `Item ${randomUUID().slice(0, 4)}`,
        basePriceCentavos: BigInt(o.price ?? 10_000),
        trackInventory: o.stock !== undefined,
        isKey: o.isKey ?? false,
        sku: `SKU-${randomUUID().slice(0, 8)}`,
        ...(o.variants
          ? {
              variants: {
                create: o.variants.map((v, i) => ({
                  name: v.name,
                  priceCentavos: BigInt(v.price),
                  sortOrder: i,
                })),
              },
            }
          : {}),
        ...(o.modifiers
          ? {
              modifierGroups: {
                create: {
                  name: 'Add-ons',
                  minSelect: o.modifiers.min,
                  maxSelect: o.modifiers.max,
                  modifiers: {
                    create: o.modifiers.options.map((m, i) => ({
                      name: m.name,
                      priceDeltaCentavos: BigInt(m.delta),
                      sortOrder: i,
                    })),
                  },
                },
              },
            }
          : {}),
        ...(o.wholesale
          ? {
              wholesalePrices: {
                create: o.wholesale.map((w) => ({
                  minQty: w.minQty,
                  unitPriceCentavos: BigInt(w.price),
                })),
              },
            }
          : {}),
        ...(o.stock !== undefined
          ? { inventoryLevels: { create: { merchantId, quantity: o.stock } } }
          : {}),
      },
      include: { variants: true, modifierGroups: { include: { modifiers: true } } },
    });
    return p;
  }

  /** Customer with a default address `northM` metres north of the centre. */
  async function customer(northM = 1000, opts: { lat?: number; lng?: number } = {}) {
    const u = await user(['customer']);
    const a = await db().address.create({
      data: {
        userId: u.id,
        label: 'Home',
        recipientName: 'Juan Dela Cruz',
        phone: '+639181234567',
        line1: '1 Test St',
        barangay: 'Test',
        city: 'Test City',
        province: 'Test',
        lat: opts.lat ?? center.lat + northM / 111_320,
        lng: opts.lng ?? center.lng,
        isDefault: true,
      },
    });
    return { userId: u.id, addressId: a.id, token: tokenFor(u.id, ['customer'], 'customer') };
  }

  /** Address far outside every fixture zone. */
  async function farAddress(userId: string) {
    return db().address.create({
      data: {
        userId,
        label: 'Far',
        recipientName: 'Juan',
        phone: '+639181234567',
        line1: 'Far St',
        barangay: 'Far',
        city: 'Far City',
        province: 'Far',
        lat: center.lat + 1,
        lng: center.lng + 1,
      },
    });
  }

  /** Approved rider working the fixture zone. */
  async function rider() {
    const u = await user(['rider']);
    const r = await db().rider.create({
      data: {
        userId: u.id,
        vehicleType: 'motorcycle',
        verificationStatus: 'approved',
        status: 'online',
        zones: { create: { zoneId, isPrimary: true } },
      },
    });
    return { riderId: r.id, userId: u.id, token: tokenFor(u.id, ['rider'], 'rider') };
  }

  return { center, zone, user, store, product, customer, farAddress, rider, tokenFor };
}
