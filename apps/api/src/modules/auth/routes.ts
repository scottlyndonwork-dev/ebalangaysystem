import { ErrorCode, Headers, type UserRole } from '@ebalangay/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import {
  assertRole,
  authOf,
  authenticate,
  clearSessionCookies,
  REFRESH_COOKIE,
  requireRole,
  setSessionCookies,
} from '../../plugins/auth.js';
import { RATE_LIMITS } from '../../plugins/rate-limit.js';
import {
  loginResponseSchema,
  logoutInputSchema,
  passwordLoginInputSchema,
  refreshResponseSchema,
  refreshTokenInputSchema,
  requestOtpInputSchema,
  requestOtpResponseSchema,
  toUserDto,
  totpDisableInputSchema,
  totpEnableInputSchema,
  totpLoginInputSchema,
  totpSetupInputSchema,
  totpSetupResponseSchema,
  verifyOtpInputSchema,
  verifyOtpResponseSchema,
  isWebApp,
} from './schemas.js';
import { authService, clientInfo, type Session } from './service.js';

const tags = ['auth'];
const WEB_ROLES: UserRole[] = ['merchant_owner', 'merchant_staff', 'admin', 'super_admin'];
const authLimit = { rateLimit: RATE_LIMITS.auth };
const credentialLimit = { rateLimit: RATE_LIMITS.credentials };

const mobileTokens = (s: Session) => ({
  accessToken: s.accessToken,
  refreshToken: s.refreshToken,
  accessTokenExpiresAt: s.accessExpiresAt.toISOString(),
});

/** Web: tokens only in httpOnly cookies. */
function sendCookieSession(reply: FastifyReply, s: Session) {
  setSessionCookies(reply, s);
  return { accessTokenExpiresAt: s.accessExpiresAt.toISOString() };
}

/** Cookie-borne credentials need the custom header too (forces a CORS preflight). */
function assertCsrfHeader(req: FastifyRequest) {
  if (!req.headers[Headers.APP_PLATFORM]) {
    throw new AppError(ErrorCode.FORBIDDEN, `Missing ${Headers.APP_PLATFORM} header`);
  }
}

/** /v1/auth/* */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = authService(app);

  r.post(
    '/otp/request',
    {
      schema: { tags, body: requestOtpInputSchema, response: { 200: requestOtpResponseSchema } },
      config: authLimit,
    },
    (req) => auth.requestOtp(req.body.phone, clientInfo(req)),
  );

  r.post(
    '/otp/verify',
    {
      schema: { tags, body: verifyOtpInputSchema, response: { 200: verifyOtpResponseSchema } },
      config: credentialLimit,
    },
    async (req) => {
      const { user, session, isNewUser } = await auth.verifyOtp(req.body, clientInfo(req), req);
      return { tokens: mobileTokens(session), user: toUserDto(user), isNewUser };
    },
  );

  r.post(
    '/refresh',
    {
      schema: {
        tags,
        body: refreshTokenInputSchema.optional(),
        response: { 200: refreshResponseSchema },
      },
      config: authLimit,
    },
    async (req, reply) => {
      let token = req.body?.refreshToken;
      if (!token) {
        token = req.cookies[REFRESH_COOKIE];
        if (token) assertCsrfHeader(req);
      }
      if (!token) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in required');
      const session = await auth.refresh(token, clientInfo(req), req);
      return isWebApp(session.app) ? sendCookieSession(reply, session) : mobileTokens(session);
    },
  );

  r.post(
    '/logout',
    { schema: { tags, body: logoutInputSchema.optional() }, config: authLimit },
    async (req, reply) => {
      const token = req.body?.refreshToken ?? req.cookies[REFRESH_COOKIE];
      // An expired access token must not block signing out.
      const sessionId = await authenticate(req).then(
        (a) => a.sessionId,
        () => undefined,
      );
      await auth.logout(token, sessionId);
      clearSessionCookies(reply);
      return reply.status(204).send();
    },
  );

  // ---- merchant-web / admin-web

  r.post(
    '/login',
    {
      schema: { tags, body: passwordLoginInputSchema, response: { 200: loginResponseSchema } },
      config: credentialLimit,
    },
    async (req, reply) => {
      const result = await auth.passwordLogin(req.body, clientInfo(req), req);
      if (result.status === 'authenticated') {
        return {
          status: 'authenticated' as const,
          user: toUserDto(result.user),
          ...sendCookieSession(reply, result.session),
        };
      }
      return { status: result.status, mfaToken: result.mfaToken, expiresInSeconds: 300 };
    },
  );

  r.post(
    '/login/totp',
    {
      schema: { tags, body: totpLoginInputSchema, response: { 200: loginResponseSchema } },
      config: credentialLimit,
    },
    async (req, reply) => {
      const { user, session } = await auth.loginWithTotp(
        req.body.mfaToken,
        req.body.code,
        clientInfo(req),
        req,
      );
      return {
        status: 'authenticated' as const,
        user: toUserDto(user),
        ...sendCookieSession(reply, session),
      };
    },
  );

  /** Signed-in merchants (optional 2FA) or admins mid-login (mfaToken with enroll=true). */
  r.post(
    '/totp/setup',
    {
      schema: {
        tags,
        body: totpSetupInputSchema.optional(),
        response: { 200: totpSetupResponseSchema },
      },
      config: credentialLimit,
    },
    async (req) => {
      if (req.body?.mfaToken) {
        const claims = await auth.readMfaToken(req.body.mfaToken, { consume: false });
        if (!claims.enroll) throw new AppError(ErrorCode.CONFLICT, 'Two-factor is already on.');
        return auth.setupTotp(claims.sub);
      }
      const me = await assertRole(req, WEB_ROLES);
      return auth.setupTotp(me.userId);
    },
  );

  r.post(
    '/totp/enable',
    {
      schema: {
        tags,
        body: totpEnableInputSchema,
        response: { 200: loginResponseSchema, 204: z.null() },
      },
      config: credentialLimit,
    },
    async (req, reply) => {
      if (req.body.mfaToken) {
        const claims = await auth.readMfaToken(req.body.mfaToken, { consume: false });
        if (!claims.enroll) throw new AppError(ErrorCode.CONFLICT, 'Two-factor is already on.');
        await auth.countMfaAttempt(claims.jti);
        const enabled = await auth.enableTotp(claims.sub, req.body.code, req);
        await auth.readMfaToken(req.body.mfaToken, { consume: true });
        const { user, session } = await auth.completeWebLogin(
          enabled,
          claims.app,
          clientInfo(req),
          req,
          'password+totp_enrolment',
        );
        return {
          status: 'authenticated' as const,
          user: toUserDto(user),
          ...sendCookieSession(reply, session),
        };
      }
      const me = await assertRole(req, WEB_ROLES);
      await auth.enableTotp(me.userId, req.body.code, req);
      return reply.status(204).send(null);
    },
  );

  r.post(
    '/totp/disable',
    {
      schema: { tags, body: totpDisableInputSchema },
      preHandler: requireRole('merchant_owner', 'merchant_staff'),
      config: credentialLimit,
    },
    async (req, reply) => {
      await auth.disableTotp(authOf(req).userId, req.body.code, req);
      return reply.status(204).send();
    },
  );
}
