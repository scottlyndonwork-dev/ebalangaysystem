import { randomUUID } from 'node:crypto';
import {
  type AppPlatform,
  type MerchantProfile,
  type PresignedUpload,
  type UserRole,
} from '@ebalangay/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refreshMerchantResponseTimes } from '../src/modules/merchants/service.js';
import { buildTestApp, randomPhone } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
let ctx: Ctx;

/** A real signed access token (auth only verifies the JWT), without running the OTP flow. */
function tokenFor(userId: string, roles: UserRole[], app: AppPlatform): string {
  return ctx.app.jwt.sign({ typ: 'access', sub: userId, roles, app, sid: randomUUID() });
}

async function newUser(roles: UserRole[] = ['customer']) {
  return ctx.app.db.user.create({ data: { phone: randomPhone(), roles, firstName: 'Test' } });
}

const api = () => request(ctx.app.server);
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const application = {
  name: "Aling Nena's Sari-Sari",
  businessType: 'retail',
  phone: '+639171234567',
  addressLine: 'J.C. Aquino Ave',
  barangay: 'Libertad',
  city: 'Butuan City',
  location: { lat: 8.9475, lng: 125.5406 },
};

/** Signed upload → simulate the PUT into memory storage → return the key. */
async function uploadDocument(token: string, merchantId: string): Promise<string> {
  const res = await api()
    .post(`/v1/merchants/${merchantId}/documents/upload-url`)
    .set(auth(token))
    .send({ contentType: 'application/pdf', sizeBytes: 1234 })
    .expect(200);
  const up = res.body as PresignedUpload;
  await ctx.storage.put('private', up.fileKey, Buffer.alloc(1234), 'application/pdf');
  return up.fileKey;
}

async function addDocument(token: string, merchantId: string, type: string) {
  const fileKey = await uploadDocument(token, merchantId);
  const res = await api()
    .post(`/v1/merchants/${merchantId}/documents`)
    .set(auth(token))
    .send({ type, fileKey, expiresOn: '2027-12-31' })
    .expect(201);
  return res.body as { id: string; status: string };
}

/** Owner + store that has been approved (active), via the real onboarding endpoints. */
async function activeStore() {
  const owner = await newUser();
  const ownerToken = tokenFor(owner.id, ['customer'], 'merchant');
  const created = await api().post('/v1/merchants').set(auth(ownerToken)).send(application);
  const merchantId = (created.body as MerchantProfile).id;
  await ctx.app.db.merchant.update({ where: { id: merchantId }, data: { status: 'active' } });
  return { owner, ownerToken, merchantId };
}

beforeAll(async () => {
  ctx = await buildTestApp({ env: { RATE_LIMIT_ENABLED: 'false' } });
});
afterAll(async () => {
  await ctx.close();
});

describe('merchant onboarding', () => {
  let ownerToken: string;
  let ownerId: string;
  let merchantId: string;
  let adminToken: string;

  beforeAll(async () => {
    const owner = await newUser();
    ownerId = owner.id;
    ownerToken = tokenFor(owner.id, ['customer'], 'merchant');
    const admin = await newUser(['admin']);
    adminToken = tokenFor(admin.id, ['admin'], 'admin-web');
  });

  it('only the merchant apps can start an application', async () => {
    const t = tokenFor(ownerId, ['customer'], 'customer');
    await api().post('/v1/merchants').set(auth(t)).send(application).expect(403);
  });

  it('creates a draft store with the caller as owner', async () => {
    const res = await api().post('/v1/merchants').set(auth(ownerToken)).send(application);
    expect(res.status).toBe(201);
    const m = res.body as MerchantProfile;
    merchantId = m.id;
    expect(m).toMatchObject({ status: 'draft', isOpen: false, closedReason: 'inactive' });
    expect(m.slug).toMatch(/^aling-nenas-sari-sari-[0-9a-f]{6}$/);

    const mine = await api().get('/v1/me/merchants').set(auth(ownerToken)).expect(200);
    expect(mine.body.items).toContainEqual(
      expect.objectContaining({ id: merchantId, rolePreset: 'owner', status: 'draft' }),
    );
    const user = await ctx.app.db.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(user.roles).toContain('merchant_owner');
  });

  it('rejects documents that were not uploaded or belong to another store', async () => {
    await api()
      .post(`/v1/merchants/${merchantId}/documents`)
      .set(auth(ownerToken))
      .send({ type: 'valid_id', fileKey: `merchants/${merchantId}/documents/nope.pdf` })
      .expect(400);
    await api()
      .post(`/v1/merchants/${merchantId}/documents`)
      .set(auth(ownerToken))
      .send({ type: 'valid_id', fileKey: `merchants/${randomUUID()}/documents/x.pdf` })
      .expect(400);
  });

  it('cannot submit until the required documents are added', async () => {
    await addDocument(ownerToken, merchantId, 'valid_id');
    const res = await api()
      .post(`/v1/merchants/${merchantId}/application/submit`)
      .set(auth(ownerToken))
      .expect(400);
    expect(res.body.error.details.missing).toEqual([['mayors_permit'], ['dti', 'sec']]);
  });

  it('submits, then locks documents while under review', async () => {
    await addDocument(ownerToken, merchantId, 'mayors_permit');
    await addDocument(ownerToken, merchantId, 'dti');
    const res = await api()
      .post(`/v1/merchants/${merchantId}/application/submit`)
      .set(auth(ownerToken))
      .expect(200);
    expect(res.body.status).toBe('pending_review');
    const fileKey = await uploadDocument(ownerToken, merchantId);
    await api()
      .post(`/v1/merchants/${merchantId}/documents`)
      .set(auth(ownerToken))
      .send({ type: 'bir', fileKey })
      .expect(409);
  });

  it('keeps admin review behind the admin-web session', async () => {
    await api().get('/v1/admin/merchant-applications').set(auth(ownerToken)).expect(403);
  });

  it('admin rejects with a reason the owner can see; owner resubmits', async () => {
    const queue = await api()
      .get('/v1/admin/merchant-applications?limit=100')
      .set(auth(adminToken))
      .expect(200);
    expect(queue.body.items.map((a: { id: string }) => a.id)).toContain(merchantId);

    await api()
      .post(`/v1/admin/merchants/${merchantId}/reject`)
      .set(auth(adminToken))
      .send({ reason: 'Mayor permit photo is blurry' })
      .expect(200);
    const profile = await api()
      .get(`/v1/merchants/${merchantId}`)
      .set(auth(ownerToken))
      .expect(200);
    expect(profile.body).toMatchObject({
      status: 'rejected',
      applicationReviewNote: 'Mayor permit photo is blurry',
    });

    const resubmit = await api()
      .post(`/v1/merchants/${merchantId}/application/submit`)
      .set(auth(ownerToken))
      .expect(200);
    expect(resubmit.body).toMatchObject({ status: 'pending_review', applicationReviewNote: null });
  });

  it('admin approves only after the required documents are approved', async () => {
    await api().post(`/v1/admin/merchants/${merchantId}/approve`).set(auth(adminToken)).expect(400);

    const detail = await api().get(`/v1/admin/merchants/${merchantId}`).set(auth(adminToken));
    expect(detail.status).toBe(200);
    expect(detail.body.owners[0].userId).toBe(ownerId);
    for (const doc of detail.body.documents as { id: string }[]) {
      await api()
        .patch(`/v1/admin/merchant-documents/${doc.id}`)
        .set(auth(adminToken))
        .send({ status: 'approved' })
        .expect(200);
    }

    const link = await api()
      .post(`/v1/admin/merchant-documents/${detail.body.documents[0].id}/download`)
      .set(auth(adminToken))
      .expect(200);
    expect(link.body.url).toContain('documents/');
    const viewed = await ctx.app.db.auditLog.count({
      where: { action: 'merchant.document.view', targetId: detail.body.documents[0].id },
    });
    expect(viewed).toBe(1);

    const approved = await api()
      .post(`/v1/admin/merchants/${merchantId}/approve`)
      .set(auth(adminToken))
      .expect(200);
    expect(approved.body.status).toBe('active');
    // A second approve is a conflict, not a silent no-op.
    await api().post(`/v1/admin/merchants/${merchantId}/approve`).set(auth(adminToken)).expect(409);
  });
});

describe('store profile, hours, pause', () => {
  let ownerToken: string;
  let merchantId: string;

  beforeAll(async () => {
    ({ ownerToken, merchantId } = await activeStore());
  });

  it('updates settings and bumps the version', async () => {
    const before = await api().get(`/v1/merchants/${merchantId}`).set(auth(ownerToken));
    const res = await api()
      .patch(`/v1/merchants/${merchantId}`)
      .set(auth(ownerToken))
      .send({ deliveryRadiusM: 3000, minOrderCentavos: 15000, advanceOrderHours: 24 })
      .expect(200);
    expect(res.body).toMatchObject({
      deliveryRadiusM: 3000,
      minOrderCentavos: 15000,
      advanceOrderHours: 24,
      version: before.body.version + 1,
    });
  });

  it('sets the logo only from this store’s uploaded image', async () => {
    const up = await api()
      .post(`/v1/merchants/${merchantId}/uploads/image`)
      .set(auth(ownerToken))
      .send({ purpose: 'logo', contentType: 'image/png', sizeBytes: 500 })
      .expect(200);
    await api()
      .patch(`/v1/merchants/${merchantId}`)
      .set(auth(ownerToken))
      .send({ logoFileKey: up.body.fileKey })
      .expect(400);
    await ctx.storage.put('public', up.body.fileKey, Buffer.alloc(500), 'image/png');
    const res = await api()
      .patch(`/v1/merchants/${merchantId}`)
      .set(auth(ownerToken))
      .send({ logoFileKey: up.body.fileKey })
      .expect(200);
    expect(res.body.logoUrl).toBe(`https://cdn.test/${up.body.fileKey}`);
  });

  it('opens with 24h hours, closes on pause and holidays', async () => {
    const allDay = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      dayOfWeek: d,
      opensAt: '00:00',
      closesAt: '00:00',
    }));
    await api()
      .put(`/v1/merchants/${merchantId}/hours`)
      .set(auth(ownerToken))
      .send({ weekly: allDay })
      .expect(200);
    let p = await api().get(`/v1/merchants/${merchantId}`).set(auth(ownerToken));
    expect(p.body).toMatchObject({ isOpen: true, closedReason: null });

    p = await api()
      .post(`/v1/merchants/${merchantId}/pause`)
      .set(auth(ownerToken))
      .send({ minutes: 30, message: 'Naubusan ng LPG' })
      .expect(200);
    expect(p.body).toMatchObject({
      isOpen: false,
      closedReason: 'paused',
      pauseMessage: 'Naubusan ng LPG',
    });
    p = await api().post(`/v1/merchants/${merchantId}/resume`).set(auth(ownerToken)).expect(200);
    expect(p.body.isOpen).toBe(true);

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    const hours = await api()
      .put(`/v1/merchants/${merchantId}/holidays/${today}`)
      .set(auth(ownerToken))
      .send({ closed: true, note: 'Fiesta' })
      .expect(200);
    expect(hours.body.holidays).toEqual([
      { date: today, closed: true, opensAt: null, closesAt: null, note: 'Fiesta' },
    ]);
    p = await api().get(`/v1/merchants/${merchantId}`).set(auth(ownerToken));
    expect(p.body.closedReason).toBe('holiday');

    await api()
      .delete(`/v1/merchants/${merchantId}/holidays/${today}`)
      .set(auth(ownerToken))
      .expect(200);
    p = await api().get(`/v1/merchants/${merchantId}`).set(auth(ownerToken));
    expect(p.body.isOpen).toBe(true);
  });

  it('special hours need both times', async () => {
    await api()
      .put(`/v1/merchants/${merchantId}/holidays/2030-01-01`)
      .set(auth(ownerToken))
      .send({ closed: false, opensAt: '10:00' })
      .expect(400);
  });
});

describe('staff management', () => {
  let ownerToken: string;
  let ownerStaffId: string;
  let merchantId: string;

  beforeAll(async () => {
    const s = await activeStore();
    ({ ownerToken, merchantId } = s);
    const staff = await ctx.app.db.merchantStaff.findFirstOrThrow({
      where: { merchantId, userId: s.owner.id },
    });
    ownerStaffId = staff.id;
  });

  const invite = (token: string, body: Record<string, unknown>) =>
    api().post(`/v1/merchants/${merchantId}/staff`).set(auth(token)).send(body);

  it('invites a new number: creates the account and texts them', async () => {
    const phone = randomPhone();
    const res = await invite(ownerToken, { phone, displayName: 'Jun', rolePreset: 'cashier' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      rolePreset: 'cashier',
      permissions: ['orders.manage', 'pos.use'],
      phone,
    });
    expect(ctx.sms.sent.at(-1)).toMatchObject({ phone });
    expect(ctx.sms.sent.at(-1)?.message).toContain("Aling Nena's Sari-Sari");
    await invite(ownerToken, { phone, displayName: 'Jun', rolePreset: 'cashier' }).expect(409);

    // The cashier can't manage staff.
    const user = await ctx.app.db.user.findUniqueOrThrow({ where: { phone } });
    const cashierToken = tokenFor(user.id, user.roles, 'merchant');
    await api().get(`/v1/merchants/${merchantId}/staff`).set(auth(cashierToken)).expect(403);
  });

  it('a non-owner manager cannot escalate', async () => {
    const phone = randomPhone();
    const created = await invite(ownerToken, {
      phone,
      displayName: 'Mgr',
      rolePreset: 'manager',
      permissions: ['staff.manage', 'orders.manage'],
    }).expect(201);
    const user = await ctx.app.db.user.findUniqueOrThrow({ where: { phone } });
    const mgrToken = tokenFor(user.id, user.roles, 'merchant');

    await invite(mgrToken, {
      phone: randomPhone(),
      displayName: 'X',
      rolePreset: 'owner',
    }).expect(403);
    await invite(mgrToken, {
      phone: randomPhone(),
      displayName: 'X',
      rolePreset: 'cashier',
      permissions: ['finance.view'],
    }).expect(403);
    // Not their own access, and not an owner's.
    await api()
      .patch(`/v1/merchants/${merchantId}/staff/${created.body.id}`)
      .set(auth(mgrToken))
      .send({ permissions: ['staff.manage', 'orders.manage', 'finance.view'] })
      .expect(403);
    await api()
      .delete(`/v1/merchants/${merchantId}/staff/${ownerStaffId}`)
      .set(auth(mgrToken))
      .expect(403);
    // Within their own permissions it works.
    await invite(mgrToken, {
      phone: randomPhone(),
      displayName: 'Kitchen',
      rolePreset: 'cashier',
      permissions: ['orders.manage'],
    }).expect(201);
  });

  it('never leaves the store without an active owner', async () => {
    await api()
      .patch(`/v1/merchants/${merchantId}/staff/${ownerStaffId}`)
      .set(auth(ownerToken))
      .send({ isActive: false })
      .expect(403);

    const phone = randomPhone();
    const second = await invite(ownerToken, {
      phone,
      displayName: 'Co-owner',
      rolePreset: 'owner',
    }).expect(201);
    expect(second.body.permissions).toHaveLength(9);
    const user = await ctx.app.db.user.findUniqueOrThrow({ where: { phone } });
    expect(user.roles).toContain('merchant_owner');
    const coToken = tokenFor(user.id, user.roles, 'merchant');
    // The co-owner may demote the first owner; then the first owner is no longer an owner.
    const demoted = await api()
      .patch(`/v1/merchants/${merchantId}/staff/${ownerStaffId}`)
      .set(auth(coToken))
      .send({ rolePreset: 'manager' })
      .expect(200);
    expect(demoted.body.rolePreset).toBe('manager');
  });

  it("can't touch another store's staff (404, not a leak)", async () => {
    const other = await activeStore();
    const otherStaff = await ctx.app.db.merchantStaff.findFirstOrThrow({
      where: { merchantId: other.merchantId },
    });
    const s = await activeStore();
    await api()
      .delete(`/v1/merchants/${s.merchantId}/staff/${otherStaff.id}`)
      .set(auth(s.ownerToken))
      .expect(404);
  });
});

describe('followers', () => {
  it('follows idempotently, lists, unfollows; drafts are not followable', async () => {
    const { merchantId } = await activeStore();
    const customer = await newUser();
    const t = tokenFor(customer.id, ['customer'], 'customer');

    await api().put(`/v1/stores/${merchantId}/follow`).set(auth(t)).expect(200);
    const again = await api().put(`/v1/stores/${merchantId}/follow`).set(auth(t)).expect(200);
    expect(again.body).toEqual({ following: true, followerCount: 1 });

    const list = await api().get('/v1/me/following?limit=1').set(auth(t)).expect(200);
    expect(list.body.items[0]).toMatchObject({ merchantId });
    expect(list.body.nextCursor).toBeNull();

    const off = await api().delete(`/v1/stores/${merchantId}/follow`).set(auth(t)).expect(200);
    expect(off.body).toEqual({ following: false, followerCount: 0 });

    const draftOwner = await newUser();
    const draft = await api()
      .post('/v1/merchants')
      .set(auth(tokenFor(draftOwner.id, ['customer'], 'merchant')))
      .send(application);
    await api().put(`/v1/stores/${draft.body.id}/follow`).set(auth(t)).expect(404);
  });
});

describe('merchant response time metric', () => {
  it('averages placed→confirmed over 30 days and resets stale values', async () => {
    const { merchantId } = await activeStore();
    const now = new Date();
    const mins = (m: number) => new Date(now.getTime() - m * 60_000);
    const order = (placed: Date, confirmed: Date | null) => ({
      code: `T${randomUUID().slice(0, 10)}`,
      merchantId,
      subtotalCentavos: 10_000n,
      totalCentavos: 10_000n,
      paymentMethod: 'cod' as const,
      placedAt: placed,
      confirmedAt: confirmed,
    });
    await ctx.app.db.order.createMany({
      data: [
        order(mins(60), new Date(mins(60).getTime() + 30_000)), // 30 s
        order(mins(30), new Date(mins(30).getTime() + 90_000)), // 90 s
        order(mins(10), null), // not confirmed yet: ignored
        order(mins(40 * 24 * 60), new Date(mins(40 * 24 * 60).getTime() + 999_000)), // too old
      ],
    });
    await refreshMerchantResponseTimes(ctx.app.db, now);
    const m = await ctx.app.db.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    expect(m.avgResponseSeconds).toBe(60);

    await refreshMerchantResponseTimes(ctx.app.db, new Date(now.getTime() + 31 * 86_400_000));
    const later = await ctx.app.db.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    expect(later.avgResponseSeconds).toBeNull();
  });
});
