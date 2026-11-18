import { STAFF_ROLE_PRESETS } from '@ebalangay/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withMerchantContext } from '../src/db.js';
import { buildTestApp, randomPhone, signInWithOtp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;

async function createMerchant(ctx: Ctx, label: string) {
  const suffix = randomPhone().slice(-9);
  return ctx.app.db.merchant.create({
    data: {
      slug: `test-${label}-${suffix}`,
      name: `Test Store ${label}`,
      businessType: 'restaurant',
      status: 'active',
      phone: randomPhone(),
      addressLine: 'J.C. Aquino Ave',
      barangay: 'Libertad',
      city: 'Butuan City',
      province: 'Agusan del Norte',
      lat: 8.9475,
      lng: 125.5406,
    },
  });
}

async function addStaff(
  ctx: Ctx,
  merchantId: string,
  phone: string,
  rolePreset: 'owner' | 'cashier',
) {
  const user = await ctx.app.db.user.create({
    data: { phone, roles: [rolePreset === 'owner' ? 'merchant_owner' : 'merchant_staff'] },
  });
  await ctx.app.db.merchantStaff.create({
    data: {
      merchantId,
      userId: user.id,
      displayName: rolePreset,
      rolePreset,
      permissions: [...STAFF_ROLE_PRESETS[rolePreset]],
    },
  });
  return user;
}

describe('merchant isolation', () => {
  let ctx: Ctx;
  let a: { id: string };
  let b: { id: string };
  let ownerA: string;
  let cashierA: string;
  let ownerACustomerApp: string;

  beforeAll(async () => {
    ctx = await buildTestApp({ env: { RATE_LIMIT_ENABLED: 'false' } });
    a = await createMerchant(ctx, 'a');
    b = await createMerchant(ctx, 'b');
    const ownerPhone = randomPhone();
    await addStaff(ctx, a.id, ownerPhone, 'owner');
    await addStaff(ctx, b.id, randomPhone(), 'owner');
    const cashierPhone = randomPhone();
    await addStaff(ctx, a.id, cashierPhone, 'cashier');

    ownerA = (await signInWithOtp(ctx, ownerPhone, 'merchant')).tokens.accessToken;
    cashierA = (await signInWithOtp(ctx, cashierPhone, 'merchant')).tokens.accessToken;
    ownerACustomerApp = (await signInWithOtp(ctx, ownerPhone, 'customer')).tokens.accessToken;
  });
  afterAll(() => ctx.close());

  const get = (path: string, token: string) =>
    request(ctx.app.server).get(path).set('authorization', `Bearer ${token}`);

  it('lets an owner read their own store', async () => {
    const res = await get(`/v1/merchants/${a.id}/access`, ownerA).expect(200);
    expect(res.body.merchant.id).toBe(a.id);
    expect(res.body.isOwner).toBe(true);
    const staff = await get(`/v1/merchants/${a.id}/staff`, ownerA).expect(200);
    expect(staff.body.items).toHaveLength(2);
    expect(staff.body.items.every((s: { merchantId: string }) => s.merchantId === a.id)).toBe(true);
  });

  it("forbids reading another merchant's data", async () => {
    for (const path of [`/v1/merchants/${b.id}/access`, `/v1/merchants/${b.id}/staff`]) {
      const res = await get(path, ownerA).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('enforces per-permission access for staff', async () => {
    const res = await get(`/v1/merchants/${a.id}/access`, cashierA).expect(200);
    expect(res.body.isOwner).toBe(false);
    expect(res.body.permissions).toEqual(['orders.manage', 'pos.use']);
    const denied = await get(`/v1/merchants/${a.id}/staff`, cashierA).expect(403);
    expect(denied.body.error.details).toEqual({ permission: 'staff.manage' });
  });

  it('applies revoked permissions immediately (no stale token claims)', async () => {
    const membership = await ctx.app.db.merchantStaff.findFirstOrThrow({
      where: { merchantId: a.id, rolePreset: 'cashier' },
    });
    await ctx.app.db.merchantStaff.update({
      where: { id: membership.id },
      data: { isActive: false },
    });
    try {
      await get(`/v1/merchants/${a.id}/access`, cashierA).expect(403);
    } finally {
      await ctx.app.db.merchantStaff.update({
        where: { id: membership.id },
        data: { isActive: true },
      });
    }
  });

  it('requires a merchant-app session, even for owners', async () => {
    await get(`/v1/merchants/${a.id}/access`, ownerACustomerApp).expect(403);
  });

  it('validates the merchant id', async () => {
    const res = await get('/v1/merchants/not-a-uuid/access', ownerA).expect(400);
    expect(res.body.error.details.issues[0].field).toBe('merchantId');
  });
});

describe('row-level security (second layer)', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await buildTestApp({ env: { RATE_LIMIT_ENABLED: 'false' } });
  });
  afterAll(() => ctx.close());

  it('runs as a role that RLS applies to', async () => {
    // A superuser or BYPASSRLS role would make the tests below pass vacuously.
    const [role] = await ctx.app.db.$queryRaw<{ bypass: boolean }[]>`
      SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
    expect(role?.bypass).toBe(false);
  });

  it("hides and protects other merchants' rows inside withMerchantContext", async () => {
    const a = await createMerchant(ctx, 'rls-a');
    const b = await createMerchant(ctx, 'rls-b');
    await addStaff(ctx, a.id, randomPhone(), 'owner');
    await addStaff(ctx, b.id, randomPhone(), 'owner');
    const stranger = await ctx.app.db.user.create({ data: { phone: randomPhone() } });

    await withMerchantContext(ctx.app.db, a.id, async (tx) => {
      // Reads: only A's rows are visible.
      const staff = await tx.merchantStaff.findMany({
        where: { merchantId: { in: [a.id, b.id] } },
      });
      expect(staff.map((s) => s.merchantId)).toEqual([a.id]);
      expect(await tx.merchant.findUnique({ where: { id: b.id } })).toBeNull();

      // Updates: B's rows can't be touched.
      const upd = await tx.merchant.updateMany({ where: { id: b.id }, data: { name: 'pwned' } });
      expect(upd.count).toBe(0);
    });

    // Inserts: writing a row for B from A's context is rejected by the policy.
    await expect(
      withMerchantContext(ctx.app.db, a.id, (tx) =>
        tx.merchantStaff.create({
          data: {
            merchantId: b.id,
            userId: stranger.id,
            displayName: 'intruder',
            rolePreset: 'manager',
            permissions: [],
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|policy/i);

    const bAfter = await ctx.app.db.merchant.findUniqueOrThrow({ where: { id: b.id } });
    expect(bAfter.name).toBe('Test Store rls-b');
  });

  it('does not leak the merchant setting to the next transaction on the connection', async () => {
    const a = await createMerchant(ctx, 'rls-c');
    await withMerchantContext(ctx.app.db, a.id, async () => undefined);
    const [row] = await ctx.app.db.$queryRaw<{ v: string | null }[]>`
      SELECT nullif(current_setting('app.current_merchant_id', true), '') AS v`;
    expect(row?.v ?? null).toBeNull();
  });
});
