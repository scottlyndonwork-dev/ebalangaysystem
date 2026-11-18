import { loginResponseSchema, type UserRole } from '@ebalangay/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt } from '../src/lib/crypto.js';
import { hashPassword } from '../src/lib/password.js';
import { generateTotp } from '../src/lib/totp.js';
import { buildTestApp, randomIp, randomPhone } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;
const PASSWORD = 'Sapat-na-Haba-2026!';

async function createWebUser(ctx: Ctx, roles: UserRole[]) {
  const phone = randomPhone();
  const email = `${phone.slice(1)}@test.ebalangay.local`;
  const user = await ctx.app.db.user.create({
    data: {
      phone,
      email,
      firstName: 'Test',
      roles,
      passwordHash: await hashPassword(PASSWORD),
    },
  });
  return { ...user, phone, email };
}

function cookiesOf(res: request.Response): Record<string, string> {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return Object.fromEntries(
    (raw ?? []).map((c) => {
      const [pair = '', ...attrs] = c.split(';');
      const [name = '', ...value] = pair.split('=');
      return [name.trim(), [value.join('='), ...attrs].join(';')];
    }),
  );
}
const cookieHeader = (res: request.Response) =>
  Object.entries(cookiesOf(res))
    .map(([k, v]) => `${k}=${v.split(';')[0]}`)
    .join('; ');

/** Seconds-precise "now" codes; +30 s gives the next step so replay protection doesn't trip. */
const codeAt = (secret: string, offsetSteps = 0) =>
  generateTotp(secret, Date.now() + offsetSteps * 30_000);

describe('merchant-web password login', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await buildTestApp({ env: { RATE_LIMIT_ENABLED: 'false' } });
  });
  afterAll(() => ctx.close());

  const login = (identifier: string, password = PASSWORD, platform = 'merchant-web') =>
    request(ctx.app.server)
      .post('/v1/auth/login')
      .set('x-forwarded-for', randomIp())
      .send({ identifier, password, platform });

  it('signs in with email or phone and keeps tokens out of the body', async () => {
    const user = await createWebUser(ctx, ['merchant_owner']);
    const res = await login(user.email.toUpperCase()).expect(200);
    const body = loginResponseSchema.parse(res.body);
    expect(body.status).toBe('authenticated');
    expect(JSON.stringify(res.body)).not.toMatch(/"accessToken"|"refreshToken"/);

    const cookies = cookiesOf(res);
    expect(cookies.eb_at).toMatch(/HttpOnly/i);
    expect(cookies.eb_at).toMatch(/SameSite=Strict/i);
    expect(cookies.eb_rt).toMatch(/Path=\/v1\/auth/);

    await request(ctx.app.server).get('/v1/me').set('cookie', cookieHeader(res)).expect(200);
    await login(user.phone).expect(200);
  });

  it('refreshes from the cookie, but only with the CSRF header', async () => {
    const user = await createWebUser(ctx, ['merchant_staff']);
    const res = await login(user.email).expect(200);
    const cookie = cookieHeader(res);

    await request(ctx.app.server).post('/v1/auth/refresh').set('cookie', cookie).expect(403);
    const ok = await request(ctx.app.server)
      .post('/v1/auth/refresh')
      .set('cookie', cookie)
      .set('x-app-platform', 'merchant-web')
      .expect(200);
    expect(Object.keys(ok.body)).toEqual(['accessTokenExpiresAt']);
    expect(cookiesOf(ok).eb_rt).toBeTruthy();

    // Cookie-authenticated writes need the header too.
    await request(ctx.app.server)
      .post('/v1/me/devices')
      .set('cookie', cookieHeader(ok))
      .send({ deviceId: 'browser', platform: 'web', app: 'merchant-web' })
      .expect(403);

    // Logout clears cookies and kills the session.
    const out = await request(ctx.app.server)
      .post('/v1/auth/logout')
      .set('cookie', cookieHeader(ok))
      .expect(204);
    expect(cookiesOf(out).eb_rt).toMatch(/Expires=Thu, 01 Jan 1970/);
    await request(ctx.app.server)
      .post('/v1/auth/refresh')
      .set('cookie', cookieHeader(ok))
      .set('x-app-platform', 'merchant-web')
      .expect(401);
  });

  it('gives one generic error for wrong password and unknown accounts', async () => {
    const user = await createWebUser(ctx, ['merchant_owner']);
    const wrong = await login(user.email, 'nope').expect(401);
    const unknown = await login(`nobody-${randomPhone().slice(1)}@test.ebalangay.local`).expect(
      401,
    );
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    const audit = await ctx.app.db.auditLog.findFirst({
      where: { action: 'auth.login_failed', actorUserId: user.id },
    });
    expect(audit).not.toBeNull();
  });

  it('locks an account after 10 failures', async () => {
    const user = await createWebUser(ctx, ['merchant_owner']);
    for (let i = 0; i < 10; i++) await login(user.email, 'wrong').expect(401);
    const res = await login(user.email).expect(429);
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('refuses accounts without a merchant role', async () => {
    const customer = await createWebUser(ctx, ['customer']);
    await login(customer.email).expect(403);
    const admin = await createWebUser(ctx, ['admin']);
    await login(admin.email).expect(403);
  });

  it('supports optional TOTP for merchants', async () => {
    const user = await createWebUser(ctx, ['merchant_owner']);
    const first = await login(user.email).expect(200);
    const cookie = cookieHeader(first);
    const setup = await request(ctx.app.server)
      .post('/v1/auth/totp/setup')
      .set('cookie', cookie)
      .set('x-app-platform', 'merchant-web')
      .send({})
      .expect(200);
    const secret = setup.body.secret as string;
    expect(setup.body.otpauthUrl).toContain(`secret=${secret}`);

    // Stored encrypted, bound to the user.
    const stored = await ctx.app.db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.totpSecretEnc).not.toContain(secret);
    expect(
      decrypt(ctx.app.env.DATA_ENCRYPTION_KEY, stored.totpSecretEnc ?? '', `totp:${user.id}`),
    ).toBe(secret);

    await request(ctx.app.server)
      .post('/v1/auth/totp/enable')
      .set('cookie', cookie)
      .set('x-app-platform', 'merchant-web')
      .send({ code: codeAt(secret) })
      .expect(204);

    const second = loginResponseSchema.parse((await login(user.email).expect(200)).body);
    expect(second.status).toBe('totp_required');
    if (second.status !== 'totp_required') return;
    const done = await request(ctx.app.server)
      .post('/v1/auth/login/totp')
      .send({ mfaToken: second.mfaToken, code: codeAt(secret, 1) })
      .expect(200);
    expect(done.body.status).toBe('authenticated');
  });
});

describe('admin-web: TOTP + IP allowlist', () => {
  let ctx: Ctx;
  const OFFICE_IP = '10.20.30.40';
  beforeAll(async () => {
    ctx = await buildTestApp({
      env: { RATE_LIMIT_ENABLED: 'false', ADMIN_IP_ALLOWLIST: '10.0.0.0/8' },
    });
  });
  afterAll(() => ctx.close());

  const login = (identifier: string, ip = OFFICE_IP) =>
    request(ctx.app.server)
      .post('/v1/auth/login')
      .set('x-forwarded-for', ip)
      .send({ identifier, password: PASSWORD, platform: 'admin-web' });

  it('requires TOTP enrolment on first login, then TOTP every login', async () => {
    const admin = await createWebUser(ctx, ['admin']);
    const first = loginResponseSchema.parse((await login(admin.email).expect(200)).body);
    expect(first.status).toBe('totp_enrollment_required');
    if (first.status !== 'totp_enrollment_required') return;
    expect(cookiesOf(await login(admin.email)).eb_at).toBeUndefined();

    // The enrolment token can't be used to skip straight to a TOTP login.
    await request(ctx.app.server)
      .post('/v1/auth/login/totp')
      .send({ mfaToken: first.mfaToken, code: '123456' })
      .expect(403);

    const setup = await request(ctx.app.server)
      .post('/v1/auth/totp/setup')
      .send({ mfaToken: first.mfaToken })
      .expect(200);
    const secret = setup.body.secret as string;
    await request(ctx.app.server)
      .post('/v1/auth/totp/enable')
      .send({ mfaToken: first.mfaToken, code: '000000' === codeAt(secret) ? '111111' : '000000' })
      .expect(400);
    const enrolCode = codeAt(secret);
    const enabled = await request(ctx.app.server)
      .post('/v1/auth/totp/enable')
      .set('x-forwarded-for', OFFICE_IP)
      .send({ mfaToken: first.mfaToken, code: enrolCode })
      .expect(200);
    expect(enabled.body.status).toBe('authenticated');
    const adminCookie = cookieHeader(enabled);

    // mfaToken is single use.
    await request(ctx.app.server)
      .post('/v1/auth/totp/enable')
      .send({ mfaToken: first.mfaToken, code: codeAt(secret, 1) })
      .expect(401);

    // Admin routes work from the office network with the admin-web session.
    const logs = await request(ctx.app.server)
      .get('/v1/admin/audit-logs?action=auth.totp.enable&limit=5')
      .set('x-forwarded-for', OFFICE_IP)
      .set('cookie', adminCookie)
      .expect(200);
    expect(logs.body.items.some((a: { actorUserId: string }) => a.actorUserId === admin.id)).toBe(
      true,
    );

    // ...and not from anywhere else, even with a valid session.
    await request(ctx.app.server)
      .get('/v1/admin/audit-logs')
      .set('x-forwarded-for', '203.0.113.9')
      .set('cookie', adminCookie)
      .expect(403);

    // Next login: TOTP required. A replayed code is refused.
    const next = loginResponseSchema.parse((await login(admin.email).expect(200)).body);
    expect(next.status).toBe('totp_required');
    if (next.status !== 'totp_required') return;
    await request(ctx.app.server)
      .post('/v1/auth/login/totp')
      .send({ mfaToken: next.mfaToken, code: enrolCode })
      .expect(400);
    await request(ctx.app.server)
      .post('/v1/auth/login/totp')
      .set('x-forwarded-for', OFFICE_IP)
      .send({ mfaToken: next.mfaToken, code: codeAt(secret, 1) })
      .expect(200);
    await request(ctx.app.server)
      .post('/v1/auth/login/totp')
      .send({ mfaToken: next.mfaToken, code: codeAt(secret, -1) })
      .expect(401);

    // Admins cannot switch 2FA off.
    await request(ctx.app.server)
      .post('/v1/auth/totp/disable')
      .set('x-forwarded-for', OFFICE_IP)
      .set('cookie', adminCookie)
      .set('x-app-platform', 'admin-web')
      .send({ code: codeAt(secret, -1) })
      .expect(403);
  });

  it('refuses admin login from outside the allowlist', async () => {
    const admin = await createWebUser(ctx, ['super_admin']);
    const res = await login(admin.email, '203.0.113.9').expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('keeps merchant sessions out of admin routes', async () => {
    const owner = await createWebUser(ctx, ['merchant_owner', 'admin']);
    const res = await request(ctx.app.server)
      .post('/v1/auth/login')
      .set('x-forwarded-for', OFFICE_IP)
      .send({ identifier: owner.email, password: PASSWORD, platform: 'merchant-web' })
      .expect(200);
    await request(ctx.app.server)
      .get('/v1/admin/audit-logs')
      .set('x-forwarded-for', OFFICE_IP)
      .set('cookie', cookieHeader(res))
      .expect(403);
  });
});

describe('auth rate limits (Redis)', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => ctx.close());

  it('limits credential endpoints to 5 per minute per IP', async () => {
    const ip = randomIp();
    const attempt = () =>
      request(ctx.app.server)
        .post('/v1/auth/login')
        .set('x-forwarded-for', ip)
        .send({
          identifier: `nobody-${randomPhone().slice(1)}@test.ebalangay.local`,
          password: 'x',
          platform: 'merchant-web',
        });
    for (let i = 0; i < 5; i++) await attempt().expect(401);
    const res = await attempt().expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    // Another client is unaffected.
    await request(ctx.app.server)
      .post('/v1/auth/login')
      .set('x-forwarded-for', randomIp())
      .send({
        identifier: `nobody-${randomPhone().slice(1)}@test.ebalangay.local`,
        password: 'x',
        platform: 'merchant-web',
      })
      .expect(401);
  });
});
