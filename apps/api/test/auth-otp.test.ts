import { apiErrorSchema, verifyOtpResponseSchema } from '@ebalangay/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ageOtps, buildTestApp, codeFor, randomIp, randomPhone, signInWithOtp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;

const requestOtp = (ctx: Ctx, phone: string, ip = randomIp()) =>
  request(ctx.app.server).post('/v1/auth/otp/request').set('x-forwarded-for', ip).send({ phone });

const verify = (ctx: Ctx, phone: string, code: string, platform = 'customer') =>
  request(ctx.app.server)
    .post('/v1/auth/otp/verify')
    .set('x-forwarded-for', randomIp())
    .send({ phone, code, platform, deviceId: 'device-1' });

describe('OTP sign-in (mobile)', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await buildTestApp({ env: { RATE_LIMIT_ENABLED: 'false' } });
  });
  afterAll(() => ctx.close());

  it('works end to end: request, SMS, verify, tokens, /v1/me', async () => {
    const phone = randomPhone();
    const req = await requestOtp(ctx, phone).expect(200);
    expect(req.body).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 30 });

    const code = ctx.sms.lastCodeFor(phone);
    expect(code).toMatch(/^\d{6}$/);
    // Only a keyed hash is stored.
    const row = await ctx.app.db.otpRequest.findFirstOrThrow({ where: { phone } });
    expect(row.codeHash).not.toContain(code);
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);

    const res = await verify(ctx, phone, codeFor(ctx, phone)).expect(200);
    const body = verifyOtpResponseSchema.parse(res.body);
    expect(body.isNewUser).toBe(true);
    expect(body.user).toMatchObject({ phone, roles: ['customer'], firstName: '' });

    const me = await request(ctx.app.server)
      .get('/v1/me')
      .set('authorization', `Bearer ${body.tokens.accessToken}`)
      .expect(200);
    expect(me.body.id).toBe(body.user.id);

    // Second sign-in finds the same user.
    const again = await signInWithOtp(ctx, phone);
    expect(again.isNewUser).toBe(false);
    expect(again.user.id).toBe(body.user.id);
  });

  it('codes are single use', async () => {
    const phone = randomPhone();
    await requestOtp(ctx, phone).expect(200);
    const code = codeFor(ctx, phone);
    await verify(ctx, phone, code).expect(200);
    const res = await verify(ctx, phone, code).expect(400);
    expect(apiErrorSchema.parse(res.body).error.code).toBe('OTP_EXPIRED');
  });

  it('counts wrong attempts and burns the code after 5', async () => {
    const phone = randomPhone();
    await requestOtp(ctx, phone).expect(200);
    const code = codeFor(ctx, phone);
    const wrong = code === '000000' ? '111111' : '000000';

    const first = await verify(ctx, phone, wrong).expect(400);
    expect(first.body.error).toMatchObject({
      code: 'OTP_INVALID',
      details: { attemptsRemaining: 4 },
    });
    for (let i = 0; i < 4; i++) await verify(ctx, phone, wrong).expect(400);
    // Even the right code is dead now.
    const res = await verify(ctx, phone, code).expect(400);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('expires codes after 5 minutes', async () => {
    const phone = randomPhone();
    await requestOtp(ctx, phone).expect(200);
    await ctx.app.db.otpRequest.updateMany({
      where: { phone },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await verify(ctx, phone, codeFor(ctx, phone)).expect(400);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('a new code replaces the previous one', async () => {
    const phone = randomPhone();
    await requestOtp(ctx, phone).expect(200);
    const old = codeFor(ctx, phone);
    await ageOtps(ctx, phone, 31_000);
    await requestOtp(ctx, phone).expect(200);
    const fresh = codeFor(ctx, phone);
    if (old !== fresh) await verify(ctx, phone, old).expect(400);
    await verify(ctx, phone, fresh).expect(200);
  });

  it('enforces the 30 s resend cooldown', async () => {
    const phone = randomPhone();
    await requestOtp(ctx, phone).expect(200);
    const res = await requestOtp(ctx, phone).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('allows at most 3 codes per phone per 15 minutes', async () => {
    const phone = randomPhone();
    for (let i = 0; i < 3; i++) {
      await requestOtp(ctx, phone).expect(200);
      await ageOtps(ctx, phone, 31_000);
    }
    const res = await requestOtp(ctx, phone).expect(429);
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.body.error.details.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);

    // Once the window passes, the phone can request again.
    await ageOtps(ctx, phone, 15 * 60 * 1000);
    await requestOtp(ctx, phone).expect(200);
  });

  it('allows at most 3 codes per IP per 15 minutes', async () => {
    const ip = randomIp();
    for (let i = 0; i < 3; i++) await requestOtp(ctx, randomPhone(), ip).expect(200);
    const res = await requestOtp(ctx, randomPhone(), ip).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('does not issue a code when SMS delivery fails', async () => {
    const phone = randomPhone();
    const send = ctx.app.sms.send;
    ctx.app.sms.send = () => Promise.reject(new Error('gateway down'));
    try {
      const res = await requestOtp(ctx, phone).expect(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    } finally {
      ctx.app.sms.send = send;
    }
    const row = await ctx.app.db.otpRequest.findFirstOrThrow({ where: { phone } });
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('returns Zod field errors for bad input', async () => {
    const res = await request(ctx.app.server)
      .post('/v1/auth/otp/verify')
      .send({ phone: '09171234567', code: '12', platform: 'admin-web' })
      .expect(400);
    const err = apiErrorSchema.parse(res.body).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    const fields = (err.details as { issues: { field: string }[] }).issues.map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(['phone', 'code', 'platform']));
  });

  it('blocks suspended accounts', async () => {
    const phone = randomPhone();
    await ctx.app.db.user.create({ data: { phone, status: 'suspended' } });
    await requestOtp(ctx, phone).expect(200);
    const res = await verify(ctx, phone, codeFor(ctx, phone)).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('refresh tokens (mobile)', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await buildTestApp({ env: { RATE_LIMIT_ENABLED: 'false' } });
  });
  afterAll(() => ctx.close());

  const refresh = (refreshToken: string) =>
    request(ctx.app.server).post('/v1/auth/refresh').send({ refreshToken });

  it('rotates on every use and keeps the session working', async () => {
    const { tokens } = await signInWithOtp(ctx, randomPhone());
    const r1 = await refresh(tokens.refreshToken).expect(200);
    expect(r1.body.refreshToken).toBeTruthy();
    expect(r1.body.refreshToken).not.toBe(tokens.refreshToken);
    const r2 = await refresh(r1.body.refreshToken).expect(200);
    await request(ctx.app.server)
      .get('/v1/me')
      .set('authorization', `Bearer ${r2.body.accessToken}`)
      .expect(200);

    // Only hashes are stored.
    const stored = await ctx.app.db.refreshToken.findMany({
      where: { tokenHash: { in: [tokens.refreshToken, r1.body.refreshToken] } },
    });
    expect(stored).toHaveLength(0);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const { tokens, user } = await signInWithOtp(ctx, randomPhone());
    const rotated = await refresh(tokens.refreshToken).expect(200);

    // Attacker replays the old token.
    const replay = await refresh(tokens.refreshToken).expect(401);
    expect(replay.body.error.code).toBe('UNAUTHENTICATED');

    // The legitimate client's newer token is dead too: the family is revoked.
    await refresh(rotated.body.refreshToken).expect(401);

    const family = await ctx.app.db.refreshToken.findMany({ where: { userId: user.id } });
    expect(family.every((t) => t.revokedAt !== null)).toBe(true);
    expect(family.some((t) => t.revokedReason === 'reuse_detected')).toBe(true);

    const audit = await ctx.app.db.auditLog.findFirst({
      where: { action: 'auth.refresh_token_reuse', actorUserId: user.id },
    });
    expect(audit).not.toBeNull();
  });

  it('treats two concurrent refreshes with one token as reuse', async () => {
    const { tokens } = await signInWithOtp(ctx, randomPhone());
    const results = await Promise.all([refresh(tokens.refreshToken), refresh(tokens.refreshToken)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toContain(401);
    // Whichever won, the family is now revoked.
    const winner = results.find((r) => r.status === 200);
    if (winner) await refresh(winner.body.refreshToken).expect(401);
  });

  it('rejects unknown and expired refresh tokens', async () => {
    await refresh('not-a-real-token').expect(401);
    const { tokens, user } = await signInWithOtp(ctx, randomPhone());
    await ctx.app.db.refreshToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await refresh(tokens.refreshToken).expect(401);
  });

  it('logout revokes the session and clears the device push token', async () => {
    const { tokens, user } = await signInWithOtp(ctx, randomPhone(), 'customer', 'device-1');
    const auth = `Bearer ${tokens.accessToken}`;
    await request(ctx.app.server)
      .post('/v1/me/devices')
      .set('authorization', auth)
      .send({
        deviceId: 'device-1',
        platform: 'android',
        app: 'customer',
        pushToken: 'ExpoPushToken[abc]',
      })
      .expect(200);

    await request(ctx.app.server)
      .post('/v1/auth/logout')
      .set('authorization', auth)
      .send({ refreshToken: tokens.refreshToken })
      .expect(204);
    await refresh(tokens.refreshToken).expect(401);
    const device = await ctx.app.db.userDevice.findFirstOrThrow({ where: { userId: user.id } });
    expect(device.pushToken).toBeNull();
  });

  it('rejects missing, forged and expired access tokens', async () => {
    const none = await request(ctx.app.server).get('/v1/me').expect(401);
    expect(none.body.error.code).toBe('UNAUTHENTICATED');
    await request(ctx.app.server)
      .get('/v1/me')
      .set('authorization', 'Bearer abc.def.ghi')
      .expect(401);

    const expired = ctx.app.jwt.sign(
      {
        typ: 'access',
        sub: '00000000-0000-7000-8000-000000000001',
        roles: ['customer'],
        app: 'customer',
        sid: 'x',
      },
      { expiresIn: '1s' },
    );
    await new Promise((r) => setTimeout(r, 1100));
    const res = await request(ctx.app.server)
      .get('/v1/me')
      .set('authorization', `Bearer ${expired}`)
      .expect(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });
});

describe('devices', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await buildTestApp({ env: { RATE_LIMIT_ENABLED: 'false' } });
  });
  afterAll(() => ctx.close());

  it('registers idempotently and moves a push token to its newest owner', async () => {
    const a = await signInWithOtp(ctx, randomPhone());
    const b = await signInWithOtp(ctx, randomPhone());
    const body = {
      deviceId: 'shared-phone',
      platform: 'android',
      app: 'customer',
      pushToken: `ExpoPushToken[${randomPhone()}]`,
    };

    const first = await request(ctx.app.server)
      .post('/v1/me/devices')
      .set('authorization', `Bearer ${a.tokens.accessToken}`)
      .send({ ...body, appVersion: '1.0.0' })
      .expect(200);
    expect(first.body).toMatchObject({
      deviceId: 'shared-phone',
      hasPushToken: true,
      app: 'customer',
    });
    await request(ctx.app.server)
      .post('/v1/me/devices')
      .set('authorization', `Bearer ${a.tokens.accessToken}`)
      .send(body)
      .expect(200);
    expect(await ctx.app.db.userDevice.count({ where: { userId: a.user.id } })).toBe(1);

    // Same phone, now signed in as B: A must stop getting B's pushes and vice versa.
    await request(ctx.app.server)
      .post('/v1/me/devices')
      .set('authorization', `Bearer ${b.tokens.accessToken}`)
      .send(body)
      .expect(200);
    const aDevice = await ctx.app.db.userDevice.findFirstOrThrow({ where: { userId: a.user.id } });
    expect(aDevice.pushToken).toBeNull();

    await request(ctx.app.server)
      .delete('/v1/me/devices/shared-phone')
      .set('authorization', `Bearer ${b.tokens.accessToken}`)
      .expect(204);
    expect(await ctx.app.db.userDevice.count({ where: { userId: b.user.id } })).toBe(0);
  });
});
