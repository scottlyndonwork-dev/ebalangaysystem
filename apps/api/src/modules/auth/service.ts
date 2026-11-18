import { randomInt, randomUUID } from 'node:crypto';
import {
  type AppPlatform,
  ErrorCode,
  type MobileAppPlatform,
  type UserRole,
  type WebAppPlatform,
} from '@ebalangay/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { User as DbUser } from '../../generated/prisma/client.js';
import { writeAudit } from '../../lib/audit.js';
import { decrypt, encrypt, hmac, randomToken, safeEqual } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../lib/totp.js';
import type { AccessClaims, MfaClaims } from '../../plugins/auth.js';
import { authRepo } from './repo.js';
import { appFromDb, appToDb } from './schemas.js';

export const OTP = {
  TTL_SECONDS: 5 * 60,
  RESEND_AFTER_SECONDS: 30,
  WINDOW_MS: 15 * 60 * 1000,
  /** Per phone and per IP, per WINDOW_MS. */
  MAX_PER_WINDOW: 3,
  MAX_ATTEMPTS: 5,
} as const;

export const LOGIN = {
  MAX_FAILURES: 10,
  LOCK_SECONDS: 15 * 60,
  MFA_TTL_SECONDS: 5 * 60,
  MFA_MAX_ATTEMPTS: 5,
} as const;

const ADMIN_ROLES: UserRole[] = ['admin', 'super_admin'];
const MERCHANT_ROLES: UserRole[] = ['merchant_owner', 'merchant_staff'];
/** Logins by these roles are written to the audit log. */
const AUDITED_ROLES: UserRole[] = [...ADMIN_ROLES, 'merchant_owner'];

const hasAny = (roles: readonly UserRole[], wanted: readonly UserRole[]) =>
  wanted.some((r) => roles.includes(r));

/** Burns comparable CPU when the account doesn't exist, so timing doesn't reveal it. */
let dummyHash: Promise<string> | null = null;

export interface Session {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  app: AppPlatform;
}

export type PasswordLoginResult =
  | { status: 'authenticated'; user: DbUser; session: Session }
  | { status: 'totp_required' | 'totp_enrollment_required'; mfaToken: string };

interface ClientInfo {
  ip: string;
  userAgent: string | null;
}

export function clientInfo(req: FastifyRequest): ClientInfo {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null };
}

export function authService(app: FastifyInstance) {
  const { env, db, redis, sms, log } = app;
  const repo = authRepo(db);

  const otpHash = (phone: string, code: string) => hmac(env.OTP_PEPPER, `otp:${phone}:${code}`);
  const refreshHash = (token: string) => hmac(env.OTP_PEPPER, `rt:${token}`);
  const totpAad = (userId: string) => `totp:${userId}`;

  async function createSession(
    user: DbUser,
    appPlatform: AppPlatform,
    client: ClientInfo,
    opts: { deviceId?: string | null; familyId?: string } = {},
    tx: Parameters<typeof repo.createRefreshToken>[0] = db,
  ): Promise<Session> {
    const now = Date.now();
    const refreshToken = randomToken();
    const familyId = opts.familyId ?? randomUUID();
    const refreshExpiresAt = new Date(now + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await repo.createRefreshToken(tx, {
      userId: user.id,
      familyId,
      tokenHash: refreshHash(refreshToken),
      app: appToDb(appPlatform),
      deviceId: opts.deviceId ?? null,
      userAgent: client.userAgent,
      ip: client.ip,
      expiresAt: refreshExpiresAt,
    });
    const claims: AccessClaims = {
      typ: 'access',
      sub: user.id,
      roles: user.roles,
      app: appPlatform,
      sid: familyId,
    };
    return {
      accessToken: app.jwt.sign(claims),
      refreshToken,
      accessExpiresAt: new Date(now + env.ACCESS_TOKEN_TTL_SECONDS * 1000),
      refreshExpiresAt,
      app: appPlatform,
    };
  }

  function assertActive(user: DbUser) {
    if (user.status !== 'active' || user.deletedAt) {
      throw new AppError(ErrorCode.FORBIDDEN, 'This account is not active. Contact support.');
    }
  }

  // ---------------------------------------------------------------- OTP (mobile apps)

  async function requestOtp(phone: string, client: ClientInfo) {
    const now = Date.now();
    const since = new Date(now - OTP.WINDOW_MS);

    for (const scope of [{ phone }, { ip: client.ip }]) {
      if ((await repo.countOtpsSince(scope, since)) >= OTP.MAX_PER_WINDOW) {
        const oldest = await repo.oldestOtpSince(scope, since);
        const retryAfterSeconds = oldest
          ? Math.max(1, Math.ceil((oldest.createdAt.getTime() + OTP.WINDOW_MS - now) / 1000))
          : Math.ceil(OTP.WINDOW_MS / 1000);
        throw new AppError(
          ErrorCode.RATE_LIMITED,
          'Too many codes requested. Please try again later.',
          { retryAfterSeconds },
        );
      }
    }
    const last = await repo.latestOtp(phone);
    if (last) {
      const wait = Math.ceil(
        (last.createdAt.getTime() + OTP.RESEND_AFTER_SECONDS * 1000 - now) / 1000,
      );
      if (wait > 0) {
        throw new AppError(ErrorCode.RATE_LIMITED, 'Please wait before requesting a new code.', {
          retryAfterSeconds: wait,
        });
      }
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const row = await repo.replaceOtp({
      phone,
      codeHash: otpHash(phone, code),
      ip: client.ip,
      expiresAt: new Date(now + OTP.TTL_SECONDS * 1000),
    });
    try {
      await sms.send(
        phone,
        `Your eBalangay code is ${code}. It expires in 5 minutes. Never share this code with anyone.`,
      );
    } catch (err) {
      await repo.expireOtp(row.id);
      log.error({ err }, 'otp sms delivery failed');
      throw new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        "We couldn't send the SMS. Please try again.",
      );
    }
    return { expiresInSeconds: OTP.TTL_SECONDS, resendAfterSeconds: OTP.RESEND_AFTER_SECONDS };
  }

  async function verifyOtp(
    input: { phone: string; code: string; platform: MobileAppPlatform; deviceId?: string },
    client: ClientInfo,
    req: FastifyRequest,
  ) {
    const otp = await repo.activeOtp(input.phone, new Date());
    if (!otp)
      throw new AppError(ErrorCode.OTP_EXPIRED, 'This code has expired. Request a new one.');

    if (!(await repo.recordOtpAttempt(otp.id, OTP.MAX_ATTEMPTS))) {
      await repo.expireOtp(otp.id);
      throw new AppError(ErrorCode.OTP_EXPIRED, 'Too many wrong attempts. Request a new code.');
    }
    if (!safeEqual(otp.codeHash, otpHash(input.phone, input.code))) {
      const attemptsRemaining = Math.max(0, OTP.MAX_ATTEMPTS - (otp.attempts + 1));
      if (attemptsRemaining === 0) await repo.expireOtp(otp.id);
      throw new AppError(ErrorCode.OTP_INVALID, 'Incorrect code.', { attemptsRemaining });
    }
    if (!(await repo.consumeOtp(otp.id))) {
      throw new AppError(ErrorCode.OTP_EXPIRED, 'This code was already used. Request a new one.');
    }

    let user = await repo.findUserByPhone(input.phone);
    const isNewUser = !user;
    if (user) {
      assertActive(user);
      user = await db.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), phoneVerifiedAt: user.phoneVerifiedAt ?? new Date() },
      });
    } else {
      user = await db.user.create({
        data: {
          phone: input.phone,
          roles: ['customer'],
          phoneVerifiedAt: new Date(),
          lastLoginAt: new Date(),
        },
      });
    }

    const session = await createSession(user, input.platform, client, {
      deviceId: input.deviceId ?? null,
    });
    if (hasAny(user.roles, AUDITED_ROLES)) {
      await writeAudit(db, req, {
        action: 'auth.login',
        actorUserId: user.id,
        actorRole: user.roles.join(','),
        targetType: 'user',
        targetId: user.id,
        metadata: { method: 'otp', app: input.platform },
      });
    }
    return { user, session, isNewUser };
  }

  // ---------------------------------------------------------------- refresh / logout

  async function refresh(rawToken: string, client: ClientInfo, req: FastifyRequest) {
    const row = await repo.findRefreshToken(refreshHash(rawToken));
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Session expired. Please sign in again.');
    }
    const onReuse = async () => {
      // A rotated token came back: it was stolen or replayed. Kill the whole sign-in.
      await repo.revokeFamily(row.familyId, 'reuse_detected');
      log.warn({ userId: row.userId, familyId: row.familyId }, 'refresh token reuse detected');
      await writeAudit(db, req, {
        action: 'auth.refresh_token_reuse',
        actorUserId: row.userId,
        actorRole: row.user.roles.join(','),
        targetType: 'refresh_token_family',
        targetId: row.familyId,
        metadata: { app: appFromDb(row.app) },
      });
      return new AppError(ErrorCode.UNAUTHENTICATED, 'Session revoked. Please sign in again.');
    };
    if (row.rotatedAt) throw await onReuse();
    if (row.user.status !== 'active' || row.user.deletedAt) {
      await repo.revokeFamily(row.familyId, 'user_inactive');
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Session expired. Please sign in again.');
    }

    const appPlatform = appFromDb(row.app);
    const session = await db.$transaction(async (tx) => {
      if (!(await repo.claimRefreshToken(tx, row.id))) return null;
      // Roles are re-read from the user so promotions/demotions apply at the next refresh.
      return createSession(
        row.user,
        appPlatform,
        client,
        { deviceId: row.deviceId, familyId: row.familyId },
        tx,
      );
    });
    // Lost a race with another refresh using the same token: also treated as reuse.
    if (!session) throw await onReuse();
    return session;
  }

  async function logout(rawToken: string | undefined, sessionId: string | undefined) {
    let familyId = sessionId;
    let device: { userId: string; deviceId: string } | null = null;
    if (rawToken) {
      const row = await repo.findRefreshToken(refreshHash(rawToken));
      if (row) {
        familyId = row.familyId;
        if (row.deviceId) device = { userId: row.userId, deviceId: row.deviceId };
      }
    }
    if (familyId) await repo.revokeFamily(familyId, 'logout');
    // A signed-out phone must stop receiving this user's push notifications.
    if (device) await repo.clearDevicePushToken(device.userId, device.deviceId);
  }

  // ---------------------------------------------------------------- password + TOTP (web)

  const failKey = (identifier: string) => `eb:login-fail:${hmac(env.OTP_PEPPER, identifier)}`;

  async function passwordLogin(
    input: { identifier: string; password: string; platform: WebAppPlatform },
    client: ClientInfo,
    req: FastifyRequest,
  ): Promise<PasswordLoginResult> {
    if (input.platform === 'admin-web' && !app.isAdminIpAllowed(client.ip)) {
      log.warn({ ip: client.ip }, 'admin login from non-allowlisted IP');
      throw new AppError(ErrorCode.FORBIDDEN, 'Not allowed from this network');
    }
    const key = failKey(input.identifier);
    const failures = Number((await redis.get(key).catch(() => null)) ?? 0);
    if (failures >= LOGIN.MAX_FAILURES) {
      throw new AppError(
        ErrorCode.RATE_LIMITED,
        'Too many failed sign-in attempts. Try again in 15 minutes.',
        { retryAfterSeconds: Math.max(1, await redis.ttl(key)) },
      );
    }

    const user = input.identifier.startsWith('+')
      ? await repo.findUserByPhone(input.identifier)
      : await repo.findUserByEmail(input.identifier);
    let ok = false;
    if (user?.passwordHash) {
      ok = await verifyPassword(input.password, user.passwordHash);
    } else {
      dummyHash ??= hashPassword('not-a-real-password');
      await verifyPassword(input.password, await dummyHash);
    }
    if (!user || !ok) {
      await redis
        .multi()
        .incr(key)
        .expire(key, LOGIN.LOCK_SECONDS)
        .exec()
        .catch(() => undefined);
      if (user && hasAny(user.roles, AUDITED_ROLES)) {
        await writeAudit(db, req, {
          action: 'auth.login_failed',
          actorUserId: user.id,
          actorRole: user.roles.join(','),
          targetType: 'user',
          targetId: user.id,
          metadata: { app: input.platform },
        });
      }
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Incorrect email/phone or password.');
    }
    await redis.del(key).catch(() => undefined);
    assertActive(user);

    const wanted = input.platform === 'admin-web' ? ADMIN_ROLES : MERCHANT_ROLES;
    if (!hasAny(user.roles, wanted)) {
      throw new AppError(ErrorCode.FORBIDDEN, "This account can't sign in here.");
    }

    const needsEnrollment = input.platform === 'admin-web' && !user.totpEnabledAt;
    if (needsEnrollment || user.totpEnabledAt) {
      const claims: MfaClaims = {
        typ: 'mfa',
        sub: user.id,
        app: input.platform,
        jti: randomUUID(),
        enroll: needsEnrollment,
      };
      return {
        status: needsEnrollment ? 'totp_enrollment_required' : 'totp_required',
        mfaToken: app.jwt.sign(claims, { expiresIn: `${LOGIN.MFA_TTL_SECONDS}s` }),
      };
    }
    return {
      status: 'authenticated',
      ...(await completeWebLogin(user, input.platform, client, req, 'password')),
    };
  }

  async function completeWebLogin(
    user: DbUser,
    platform: WebAppPlatform,
    client: ClientInfo,
    req: FastifyRequest,
    method: string,
  ) {
    const updated = await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    const session = await createSession(updated, platform, client);
    if (hasAny(user.roles, AUDITED_ROLES)) {
      await writeAudit(db, req, {
        action: 'auth.login',
        actorUserId: user.id,
        actorRole: user.roles.join(','),
        targetType: 'user',
        targetId: user.id,
        metadata: { method, app: platform },
      });
    }
    return { user: updated, session };
  }

  /** Verifies an mfaToken. `consume` makes it single-use (on the step that finishes sign-in). */
  async function readMfaToken(token: string, opts: { consume: boolean }): Promise<MfaClaims> {
    let claims: AccessClaims | MfaClaims;
    try {
      claims = app.jwt.verify<AccessClaims | MfaClaims>(token);
    } catch {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign-in step expired. Start again.');
    }
    if (claims.typ !== 'mfa') throw new AppError(ErrorCode.UNAUTHENTICATED, 'Invalid token');
    if (!opts.consume && (await redis.exists(`eb:mfa-used:${claims.jti}`))) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign-in step expired. Start again.');
    }
    if (opts.consume) {
      const first = await redis.set(
        `eb:mfa-used:${claims.jti}`,
        '1',
        'EX',
        LOGIN.MFA_TTL_SECONDS,
        'NX',
      );
      if (first !== 'OK') {
        throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign-in step expired. Start again.');
      }
    }
    return claims;
  }

  async function countMfaAttempt(jti: string) {
    const key = `eb:mfa-attempts:${jti}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, LOGIN.MFA_TTL_SECONDS);
    if (n > LOGIN.MFA_MAX_ATTEMPTS) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Too many wrong codes. Start again.');
    }
  }

  /** Verifies a TOTP code and blocks reuse of the same code (same 30 s step). */
  async function checkTotp(user: DbUser, code: string) {
    if (!user.totpSecretEnc) throw new AppError(ErrorCode.CONFLICT, 'Two-factor is not set up');
    const secret = decrypt(env.DATA_ENCRYPTION_KEY, user.totpSecretEnc, totpAad(user.id));
    const step = verifyTotp(secret, code);
    if (step === null) throw new AppError(ErrorCode.OTP_INVALID, 'Incorrect code.');
    const fresh = await redis.set(`eb:totp-step:${user.id}:${step}`, '1', 'EX', 120, 'NX');
    if (fresh !== 'OK') {
      throw new AppError(
        ErrorCode.OTP_INVALID,
        'That code was already used. Wait for the next one.',
      );
    }
  }

  async function loadUser(id: string) {
    const user = await repo.findUser(id);
    if (!user) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in required');
    assertActive(user);
    return user;
  }

  async function loginWithTotp(
    mfaToken: string,
    code: string,
    client: ClientInfo,
    req: FastifyRequest,
  ) {
    const claims = await readMfaToken(mfaToken, { consume: false });
    if (claims.enroll) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Set up two-factor authentication first.');
    }
    await countMfaAttempt(claims.jti);
    const user = await loadUser(claims.sub);
    if (!user.totpEnabledAt) throw new AppError(ErrorCode.CONFLICT, 'Two-factor is not set up');
    await checkTotp(user, code);
    await readMfaToken(mfaToken, { consume: true });
    return completeWebLogin(user, claims.app, client, req, 'password+totp');
  }

  async function setupTotp(userId: string) {
    const user = await loadUser(userId);
    if (user.totpEnabledAt) {
      throw new AppError(ErrorCode.CONFLICT, 'Two-factor authentication is already on.');
    }
    const secret = generateTotpSecret();
    await db.user.update({
      where: { id: user.id },
      data: { totpSecretEnc: encrypt(env.DATA_ENCRYPTION_KEY, secret, totpAad(user.id)) },
    });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email ?? user.phone ?? user.id) };
  }

  async function enableTotp(userId: string, code: string, req: FastifyRequest) {
    const user = await loadUser(userId);
    if (user.totpEnabledAt) {
      throw new AppError(ErrorCode.CONFLICT, 'Two-factor authentication is already on.');
    }
    await checkTotp(user, code);
    const updated = await db.user.update({
      where: { id: user.id },
      data: { totpEnabledAt: new Date() },
    });
    await writeAudit(db, req, {
      action: 'auth.totp.enable',
      actorUserId: user.id,
      actorRole: user.roles.join(','),
      targetType: 'user',
      targetId: user.id,
    });
    return updated;
  }

  async function disableTotp(userId: string, code: string, req: FastifyRequest) {
    const user = await loadUser(userId);
    if (hasAny(user.roles, ADMIN_ROLES)) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Admins must keep two-factor authentication on.');
    }
    if (!user.totpEnabledAt) throw new AppError(ErrorCode.CONFLICT, 'Two-factor is not on.');
    await checkTotp(user, code);
    await db.user.update({
      where: { id: user.id },
      data: { totpSecretEnc: null, totpEnabledAt: null },
    });
    await writeAudit(db, req, {
      action: 'auth.totp.disable',
      actorUserId: user.id,
      actorRole: user.roles.join(','),
      targetType: 'user',
      targetId: user.id,
    });
  }

  return {
    requestOtp,
    verifyOtp,
    refresh,
    logout,
    passwordLogin,
    loginWithTotp,
    readMfaToken,
    countMfaAttempt,
    setupTotp,
    enableTotp,
    disableTotp,
    completeWebLogin,
    loadUser,
  };
}

export type AuthService = ReturnType<typeof authService>;
