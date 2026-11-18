// Dev/demo seed for Butuan City. Idempotent: safe to run repeatedly. Run: pnpm db:seed
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ALL_MERCHANT_PERMISSIONS, STAFF_ROLE_PRESETS } from '@ebalangay/shared';
import { createDb, type Tx } from '../src/db.js';
import type { BusinessType, Prisma, UserRole } from '../src/generated/prisma/client.js';
import { PLATFORM_OWNER_ID } from '../src/lib/constants.js';
import { hashPassword } from '../src/lib/password.js';

if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
if (process.env.NODE_ENV === 'production')
  throw new Error('Refusing to seed a production database.');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const db = createDb(databaseUrl);
const peso = (n: number) => BigInt(Math.round(n * 100));

// ---------------------------------------------------------------------------------------------
// Zones: PLACEHOLDER rectangles around Butuan City districts. Replace with real boundaries.
// ---------------------------------------------------------------------------------------------
const box = (lat: number, lng: number, dLat: number, dLng: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lng - dLng, lat - dLat],
      [lng + dLng, lat - dLat],
      [lng + dLng, lat + dLat],
      [lng - dLng, lat + dLat],
      [lng - dLng, lat - dLat],
    ],
  ],
});

const ZONES = [
  { name: 'Butuan Central', lat: 8.9475, lng: 125.5406, d: 0.015 },
  { name: 'Libertad', lat: 8.944, lng: 125.505, d: 0.018 },
  { name: 'Bancasi', lat: 8.951, lng: 125.47, d: 0.016 },
  { name: 'Ampayon', lat: 8.96, lng: 125.6, d: 0.02 },
];

async function seedZones() {
  const ids: Record<string, string> = {};
  for (const z of ZONES) {
    const zone = await db.zone.upsert({
      where: { city_name: { city: 'Butuan City', name: z.name } },
      update: {},
      create: {
        name: z.name,
        city: 'Butuan City',
        province: 'Agusan del Norte',
        boundaryGeojson: box(z.lat, z.lng, z.d, z.d),
        baseDeliveryFeeCentavos: peso(49),
        perKmFeeCentavos: peso(10),
        feeTiers: {
          create: [
            { minDistanceM: 0, maxDistanceM: 3000, feeCentavos: peso(49) },
            { minDistanceM: 3000, maxDistanceM: 6000, feeCentavos: peso(69) },
            { minDistanceM: 6000, maxDistanceM: 10000, feeCentavos: peso(99) },
          ],
        },
      },
    });
    ids[z.name] = zone.id;
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Users and wallets
// ---------------------------------------------------------------------------------------------
async function upsertUser(data: {
  phone: string;
  firstName: string;
  lastName: string;
  roles: UserRole[];
  locale?: 'en' | 'fil' | 'ceb';
  email?: string;
  passwordHash?: string;
}) {
  return db.user.upsert({
    where: { phone: data.phone },
    update: { roles: data.roles },
    create: { ...data, phoneVerifiedAt: new Date(), referralCode: `EB${data.phone.slice(-6)}` },
  });
}

async function ensureWallet(
  ownerType: 'customer' | 'rider' | 'merchant' | 'platform',
  ownerId: string,
  purpose = 'main',
) {
  return db.wallet.upsert({
    where: { ownerType_ownerId_purpose: { ownerType, ownerId, purpose } },
    update: {},
    create: { ownerType, ownerId, purpose, allowNegative: ownerType === 'platform' },
  });
}

/** Balanced two-sided journal; the DB trigger rejects it at commit if it doesn't sum to 0. */
async function postJournal(
  tx: Tx,
  entries: {
    walletId: string;
    amount: bigint;
    type: Prisma.WalletTransactionCreateManyInput['type'];
    description: string;
    /** Idempotency keys are unique per wallet; override when a shared wallet takes many journals. */
    idempotencyKey?: string;
  }[],
  idempotencyKey: string,
) {
  const journalId = randomUUID();
  for (const e of entries) {
    const wallet = await tx.wallet.update({
      where: { id: e.walletId },
      data: { balanceCentavos: { increment: e.amount }, version: { increment: 1 } },
    });
    await tx.walletTransaction.create({
      data: {
        journalId,
        walletId: e.walletId,
        type: e.type,
        amountCentavos: e.amount,
        balanceAfterCentavos: wallet.balanceCentavos,
        description: e.description,
        idempotencyKey: e.idempotencyKey ?? idempotencyKey,
      },
    });
  }
}

async function seedPlatform() {
  const accounts = [
    'cash_clearing',
    'revenue',
    'cod_receivable',
    'payouts_clearing',
    'promo_expense',
  ];
  const wallets: Record<string, string> = {};
  for (const purpose of accounts)
    wallets[purpose] = (await ensureWallet('platform', PLATFORM_OWNER_ID, purpose)).id;
  return wallets;
}

// ---------------------------------------------------------------------------------------------
// Merchants
// ---------------------------------------------------------------------------------------------
interface SeedProduct {
  name: string;
  price: number;
  category: string;
  description?: string;
  variants?: { name: string; price: number }[];
  modifiers?: {
    name: string;
    min: number;
    max: number;
    options: { name: string; delta: number }[];
  };
  stock?: number;
  wholesale?: { minQty: number; price: number }[];
}

interface SeedMerchant {
  slug: string;
  name: string;
  businessType: BusinessType;
  ownerPhone: string;
  ownerName: [string, string];
  zone: string;
  lat: number;
  lng: number;
  barangay: string;
  addressLine: string;
  tags: string[];
  hours: [string, string];
  products: SeedProduct[];
}

const MERCHANTS: SeedMerchant[] = [
  {
    slug: 'lutong-bahay-ni-aling-nena',
    name: 'Lutong Bahay ni Aling Nena',
    businessType: 'restaurant',
    ownerPhone: '+639170000201',
    ownerName: ['Nena', 'Villanueva'],
    zone: 'Butuan Central',
    lat: 8.9489,
    lng: 125.5432,
    barangay: 'Holy Redeemer',
    addressLine: '45 Montilla Blvd',
    tags: ['filipino', 'carinderia'],
    hours: ['07:00', '21:00'],
    products: [
      {
        name: 'Chicken Adobo',
        price: 120,
        category: 'Ulam',
        description: 'Classic soy-vinegar adobo.',
        modifiers: {
          name: 'Add-ons',
          min: 0,
          max: 2,
          options: [
            { name: 'Extra rice', delta: 15 },
            { name: 'Boiled egg', delta: 12 },
          ],
        },
      },
      {
        name: 'Pork Sinigang',
        price: 150,
        category: 'Ulam',
        variants: [
          { name: 'Solo', price: 150 },
          { name: 'Family', price: 420 },
        ],
      },
      { name: 'Pancit Bisaya', price: 95, category: 'Noodles' },
      { name: 'Halo-halo', price: 85, category: 'Desserts' },
      { name: 'Calamansi Juice', price: 45, category: 'Drinks' },
    ],
  },
  {
    slug: 'butuan-fresh-mart',
    name: 'Butuan Fresh Mart',
    businessType: 'grocery',
    ownerPhone: '+639170000202',
    ownerName: ['Ramon', 'Ochoa'],
    zone: 'Libertad',
    lat: 8.9431,
    lng: 125.5089,
    barangay: 'Libertad',
    addressLine: 'J.C. Aquino Ave cor. Libertad Rd',
    tags: ['grocery', 'fresh-produce'],
    hours: ['06:00', '22:00'],
    products: [
      { name: 'Rice (Dinorado) 5kg', price: 365, category: 'Rice & Grains', stock: 40 },
      { name: 'Fresh Eggs (Tray of 30)', price: 255, category: 'Dairy & Eggs', stock: 25 },
      { name: 'Bangus (per kg)', price: 210, category: 'Seafood', stock: 15 },
      { name: 'Cooking Oil 1L', price: 98, category: 'Pantry', stock: 60 },
      { name: 'Instant Coffee 3-in-1 (10s)', price: 72, category: 'Pantry', stock: 80 },
    ],
  },
  {
    slug: 'botika-sa-barangay',
    name: 'Botika sa Barangay',
    businessType: 'pharmacy',
    ownerPhone: '+639170000203',
    ownerName: ['Liza', 'Fernandez'],
    zone: 'Butuan Central',
    lat: 8.9502,
    lng: 125.5378,
    barangay: 'Diego Silang',
    addressLine: '12 San Francisco St',
    tags: ['pharmacy', 'health'],
    hours: ['08:00', '20:00'],
    products: [
      { name: 'Paracetamol 500mg (10 tablets)', price: 45, category: 'Pain & Fever', stock: 100 },
      { name: 'Vitamin C 500mg (30 tablets)', price: 180, category: 'Vitamins', stock: 50 },
      { name: 'Oral Rehydration Salts (5 sachets)', price: 60, category: 'First Aid', stock: 70 },
      { name: 'Face Masks (Box of 50)', price: 150, category: 'Personal Care', stock: 30 },
    ],
  },
  {
    slug: 'agusan-hardware-and-supplies',
    name: 'Agusan Hardware & Supplies',
    businessType: 'retail',
    ownerPhone: '+639170000204',
    ownerName: ['Dante', 'Galicia'],
    zone: 'Bancasi',
    lat: 8.9497,
    lng: 125.4786,
    barangay: 'Bancasi',
    addressLine: 'National Highway, Purok 3',
    tags: ['hardware'],
    hours: ['08:00', '18:00'],
    products: [
      { name: 'LED Bulb 9W', price: 89, category: 'Electrical', stock: 120 },
      { name: 'PVC Pipe 1/2" x 3m', price: 135, category: 'Plumbing', stock: 45 },
      { name: 'Latex Paint 4L (White)', price: 760, category: 'Paint', stock: 12 },
      { name: 'Claw Hammer', price: 320, category: 'Tools', stock: 18 },
    ],
  },
  {
    slug: 'caraga-wholesale-trading',
    name: 'Caraga Wholesale Trading',
    businessType: 'wholesaler',
    ownerPhone: '+639170000205',
    ownerName: ['Grace', 'Tan'],
    zone: 'Ampayon',
    lat: 8.9612,
    lng: 125.5987,
    barangay: 'Ampayon',
    addressLine: 'Km 7 Ampayon Bypass Rd',
    tags: ['wholesale'],
    hours: ['07:00', '17:00'],
    products: [
      {
        name: 'Canned Sardines 155g (per can)',
        price: 24,
        category: 'Canned Goods',
        stock: 2400,
        wholesale: [
          { minQty: 48, price: 21.5 },
          { minQty: 240, price: 20 },
        ],
      },
      {
        name: 'Instant Noodles (per pack)',
        price: 14,
        category: 'Noodles',
        stock: 5000,
        wholesale: [
          { minQty: 72, price: 12.5 },
          { minQty: 360, price: 11.75 },
        ],
      },
      {
        name: 'Laundry Detergent 1kg',
        price: 115,
        category: 'Household',
        stock: 600,
        wholesale: [{ minQty: 24, price: 104 }],
      },
    ],
  },
];

async function seedMerchants(zoneIds: Record<string, string>) {
  const tagIds: Record<string, string> = {};
  for (const slug of new Set(MERCHANTS.flatMap((m) => m.tags))) {
    const name = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    tagIds[slug] = (
      await db.storeTag.upsert({ where: { slug }, update: {}, create: { slug, name } })
    ).id;
  }

  const result: { id: string; slug: string }[] = [];
  for (const m of MERCHANTS) {
    const owner = await upsertUser({
      phone: m.ownerPhone,
      firstName: m.ownerName[0],
      lastName: m.ownerName[1],
      roles: ['customer', 'merchant_owner'],
      email: `${m.slug}@demo.ebalangay.local`,
    });
    const merchant = await db.merchant.upsert({
      where: { slug: m.slug },
      update: {},
      create: {
        slug: m.slug,
        name: m.name,
        businessType: m.businessType,
        status: 'active',
        verifiedBadge: true,
        trustScore: 80,
        phone: m.ownerPhone,
        addressLine: m.addressLine,
        barangay: m.barangay,
        city: 'Butuan City',
        province: 'Agusan del Norte',
        lat: m.lat,
        lng: m.lng,
        zoneId: zoneIds[m.zone] ?? null,
        description: `Demo ${m.businessType} in ${m.barangay}, Butuan City.`,
      },
    });
    result.push({ id: merchant.id, slug: m.slug });
    await ensureWallet('merchant', merchant.id);

    await db.merchantStaff.upsert({
      where: { merchantId_userId: { merchantId: merchant.id, userId: owner.id } },
      update: {},
      create: {
        merchantId: merchant.id,
        userId: owner.id,
        displayName: `${m.ownerName[0]} ${m.ownerName[1]}`,
        rolePreset: 'owner',
        permissions: [...ALL_MERCHANT_PERMISSIONS],
      },
    });

    // Catalog, hours and tags are created once per merchant.
    if ((await db.product.count({ where: { merchantId: merchant.id } })) > 0) continue;

    await db.storeHours.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        merchantId: merchant.id,
        dayOfWeek,
        opensAt: m.hours[0],
        closesAt: m.hours[1],
      })),
    });
    await db.merchantTag.createMany({
      data: m.tags.map((t) => ({ merchantId: merchant.id, tagId: tagIds[t] as string })),
    });

    const categoryIds: Record<string, string> = {};
    for (const [i, name] of [...new Set(m.products.map((p) => p.category))].entries()) {
      categoryIds[name] = (
        await db.category.create({ data: { merchantId: merchant.id, name, sortOrder: i } })
      ).id;
    }
    for (const [i, p] of m.products.entries()) {
      const product = await db.product.create({
        data: {
          merchantId: merchant.id,
          categoryId: categoryIds[p.category] ?? null,
          name: p.name,
          description: p.description ?? null,
          basePriceCentavos: peso(p.price),
          trackInventory: p.stock !== undefined,
          sortOrder: i,
          variants: p.variants
            ? {
                create: p.variants.map((v, j) => ({
                  name: v.name,
                  priceCentavos: peso(v.price),
                  sortOrder: j,
                })),
              }
            : undefined,
          modifierGroups: p.modifiers
            ? {
                create: {
                  name: p.modifiers.name,
                  minSelect: p.modifiers.min,
                  maxSelect: p.modifiers.max,
                  modifiers: {
                    create: p.modifiers.options.map((o, j) => ({
                      name: o.name,
                      priceDeltaCentavos: peso(o.delta),
                      sortOrder: j,
                    })),
                  },
                },
              }
            : undefined,
          wholesalePrices: p.wholesale
            ? {
                create: p.wholesale.map((w) => ({
                  minQty: w.minQty,
                  unitPriceCentavos: peso(w.price),
                })),
              }
            : undefined,
        },
      });
      if (p.stock !== undefined) {
        await db.inventoryLevel.create({
          data: { merchantId: merchant.id, productId: product.id, quantity: p.stock },
        });
        await db.inventoryMovement.create({
          data: {
            merchantId: merchant.id,
            productId: product.id,
            delta: p.stock,
            reason: 'restock',
            note: 'Seed stock',
          },
        });
      }
    }
  }

  // A cashier for the restaurant, to exercise staff permissions.
  const restaurant = result.find((r) => r.slug === 'lutong-bahay-ni-aling-nena');
  if (restaurant) {
    const cashier = await upsertUser({
      phone: '+639170000211',
      firstName: 'Joy',
      lastName: 'Cabahug',
      roles: ['merchant_staff'],
    });
    await db.merchantStaff.upsert({
      where: { merchantId_userId: { merchantId: restaurant.id, userId: cashier.id } },
      update: {},
      create: {
        merchantId: restaurant.id,
        userId: cashier.id,
        displayName: 'Joy (Cashier)',
        rolePreset: 'cashier',
        permissions: [...STAFF_ROLE_PRESETS.cashier],
      },
    });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Riders, customers, admin, platform config
// ---------------------------------------------------------------------------------------------
const RIDERS = [
  ['Mark', 'Lagura', 'Butuan Central', 'KA 1234'],
  ['Jessa', 'Montero', 'Butuan Central', 'KB 5678'],
  ['Romeo', 'Dumaguit', 'Libertad', 'KC 9012'],
  ['Arnel', 'Pacana', 'Bancasi', 'KD 3456'],
  ['Kevin', 'Sumalinog', 'Ampayon', 'KE 7890'],
] as const;

async function seedRiders(zoneIds: Record<string, string>) {
  for (const [i, [first, last, zone, plate]] of RIDERS.entries()) {
    const user = await upsertUser({
      phone: `+63917000030${i + 1}`,
      firstName: first,
      lastName: last,
      roles: ['rider'],
      locale: 'ceb',
    });
    const rider = await db.rider.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        vehicleType: 'motorcycle',
        plateNumber: plate,
        verificationStatus: 'approved',
      },
    });
    const zoneId = zoneIds[zone];
    if (zoneId) {
      await db.riderZone.upsert({
        where: { riderId_zoneId: { riderId: rider.id, zoneId } },
        update: {},
        create: { riderId: rider.id, zoneId, isPrimary: true },
      });
    }
    await ensureWallet('rider', rider.id);
  }
}

const CUSTOMERS = [
  {
    phone: '+639170000101',
    firstName: 'Juan',
    lastName: 'Dela Cruz',
    locale: 'ceb',
    barangay: 'Holy Redeemer',
    lat: 8.9468,
    lng: 125.5447,
  },
  {
    phone: '+639170000102',
    firstName: 'Maria',
    lastName: 'Santos',
    locale: 'fil',
    barangay: 'Libertad',
    lat: 8.9422,
    lng: 125.5061,
  },
  {
    phone: '+639170000103',
    firstName: 'Pedro',
    lastName: 'Reyes',
    locale: 'en',
    barangay: 'Ampayon',
    lat: 8.9588,
    lng: 125.6023,
  },
] as const;

async function seedCustomers(platformWallets: Record<string, string>) {
  for (const c of CUSTOMERS) {
    const user = await upsertUser({
      phone: c.phone,
      firstName: c.firstName,
      lastName: c.lastName,
      roles: ['customer'],
      locale: c.locale,
    });
    if ((await db.address.count({ where: { userId: user.id } })) === 0) {
      await db.address.create({
        data: {
          userId: user.id,
          label: 'Home',
          recipientName: `${c.firstName} ${c.lastName}`,
          phone: c.phone,
          line1: 'Purok 2',
          barangay: c.barangay,
          city: 'Butuan City',
          province: 'Agusan del Norte',
          postalCode: '8600',
          lat: c.lat,
          lng: c.lng,
          riderNotes: 'Blue gate beside the sari-sari store.',
          isDefault: true,
        },
      });
    }
    await db.pointsAccount.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
    });

    const wallet = await ensureWallet('customer', user.id);
    const key = 'seed-demo-topup';
    const already = await db.walletTransaction.findUnique({
      where: { walletId_idempotencyKey: { walletId: wallet.id, idempotencyKey: key } },
    });
    const cash = platformWallets.cash_clearing;
    if (!already && cash) {
      await db.$transaction((tx) =>
        postJournal(
          tx,
          [
            {
              walletId: wallet.id,
              amount: peso(500),
              type: 'top_up',
              description: 'Demo wallet top-up',
            },
            {
              walletId: cash,
              amount: -peso(500),
              type: 'top_up',
              description: `Demo top-up for ${c.phone}`,
              idempotencyKey: `${key}:${user.id}`,
            },
          ],
          key,
        ),
      );
    }
  }
}

async function seedAdmin() {
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe-Dev-2026!';
  const existing = await db.user.findUnique({ where: { phone: '+639170000001' } });
  await db.user.upsert({
    where: { phone: '+639170000001' },
    update: { roles: ['super_admin'] },
    create: {
      phone: '+639170000001',
      email: 'admin@ebalangay.local',
      firstName: 'Platform',
      lastName: 'Admin',
      roles: ['super_admin'],
      passwordHash: await hashPassword(password),
      phoneVerifiedAt: new Date(),
    },
  });
  return { created: !existing, password };
}

async function seedPlatformConfig() {
  const flags = [
    ['group_orders', 'Group carts and split ordering', false],
    ['teams', 'Teams (company allowances)', false],
    ['gives_back', 'Round-up donations at checkout', true],
    ['flash_sales', 'Flash sale events', false],
    ['rider_insurance', 'Per-trip rider insurance', false],
  ] as const;
  for (const [key, description, enabled] of flags) {
    await db.featureFlag.upsert({
      where: { key },
      update: {},
      create: { key, description, enabled },
    });
  }
  for (const app of ['customer', 'rider', 'merchant'] as const) {
    for (const os of ['ios', 'android'] as const) {
      await db.appVersion.upsert({
        where: { app_os: { app, os } },
        update: {},
        create: { app, os, minVersion: '0.0.0', latestVersion: '0.1.0' },
      });
    }
  }
  for (const [slug, name] of [
    ['first_delivery', 'First Delivery'],
    ['five_star_week', 'Five-Star Week'],
    ['rainy_day_hero', 'Rainy Day Hero'],
  ] as const) {
    await db.badge.upsert({ where: { slug }, update: {}, create: { slug, name } });
  }
  const now = new Date();
  await db.voucher.upsert({
    where: { code: 'WELCOME50' },
    update: {},
    create: {
      code: 'WELCOME50',
      title: '₱50 off your first order',
      discountType: 'fixed',
      amountCentavos: peso(50),
      minSpendCentavos: peso(200),
      funding: 'platform',
      newUsersOnly: true,
      startsAt: now,
      endsAt: new Date(now.getTime() + 365 * 86_400_000),
    },
  });
}

async function main() {
  const zoneIds = await seedZones();
  const platformWallets = await seedPlatform();
  const merchants = await seedMerchants(zoneIds);
  await seedRiders(zoneIds);
  await seedCustomers(platformWallets);
  const admin = await seedAdmin();
  await seedPlatformConfig();

  console.log(
    `Seeded ${Object.keys(zoneIds).length} zones, ${merchants.length} merchants, ${RIDERS.length} riders, ${CUSTOMERS.length} customers, 1 admin.`,
  );
  if (admin.created) {
    console.log(
      `Admin: admin@ebalangay.local / ${admin.password} (dev only; TOTP enrolment required on first login)`,
    );
  }
}

try {
  await main();
} finally {
  await db.$disconnect();
}
