import jwt from '@fastify/jwt';
import {
  type AppPlatform,
  ErrorCode,
  Headers,
  type MerchantPermission,
  ALL_MERCHANT_PERMISSIONS,
  type UserRole,
} from '@ebalangay/shared';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';
import { createIpAllowlist } from '../lib/ip-allowlist.js';

export const ACCESS_COOKIE = 'eb_at';
export const REFRESH_COOKIE = 'eb_rt';
/** The refresh cookie is only ever sent to the auth routes. */
export const REFRESH_COOKIE_PATH = '/v1/auth';

export interface AccessClaims {
  typ: 'access';
  sub: string;
  roles: UserRole[];
  app: AppPlatform;
  /** Refresh-token family: one per sign-in. */
  sid: string;
}

/** Second-factor step of a web login. Not a session; single use (jti). */
export interface MfaClaims {
  typ: 'mfa';
  sub: string;
  app: 'merchant-web' | 'admin-web';
  jti: string;
  /** True when the user must enrol TOTP before finishing sign-in. */
  enroll: boolean;
}

export interface AuthContext {
  userId: string;
  roles: UserRole[];
  app: AppPlatform;
  sessionId: string;
  /** Web sessions use cookies; CSRF rules apply to them. */
  via: 'bearer' | 'cookie';
}

export interface MerchantAccess {
  merchantId: string;
  staffId: string;
  isOwner: boolean;
  permissions: readonly MerchantPermission[];
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessClaims | MfaClaims;
    user: AccessClaims;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    merchantAccess: MerchantAccess | null;
  }
  interface FastifyInstance {
    isAdminIpAllowed: (ip: string) => boolean;
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [scheme, token] = h.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/** Resolves and caches the caller from the Bearer header or (web) the access cookie. */
export async function authenticate(req: FastifyRequest): Promise<AuthContext> {
  if (req.auth) return req.auth;
  const header = bearer(req);
  const token = header ?? req.cookies[ACCESS_COOKIE];
  if (!token) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in required');

  let claims: AccessClaims | MfaClaims;
  try {
    claims = req.server.jwt.verify<AccessClaims | MfaClaims>(token);
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw code?.includes('EXPIRED')
      ? new AppError(ErrorCode.TOKEN_EXPIRED, 'Session expired')
      : new AppError(ErrorCode.UNAUTHENTICATED, 'Invalid token');
  }
  if (claims.typ !== 'access') throw new AppError(ErrorCode.UNAUTHENTICATED, 'Invalid token');

  const via = header ? 'bearer' : 'cookie';
  // Cookie sessions: a custom header forces a CORS preflight, so other sites can't forge writes.
  if (via === 'cookie' && UNSAFE_METHODS.has(req.method) && !req.headers[Headers.APP_PLATFORM]) {
    throw new AppError(ErrorCode.FORBIDDEN, `Missing ${Headers.APP_PLATFORM} header`);
  }

  req.auth = {
    userId: claims.sub,
    roles: claims.roles,
    app: claims.app,
    sessionId: claims.sid,
    via,
  };
  return req.auth;
}

/** The caller, for handlers behind requireAuth/requireRole/requireMerchantPermission. */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new Error('authOf() used on a route without an auth preHandler');
  return req.auth;
}

/** The merchant membership, for handlers behind requireMerchantPermission. */
export function merchantAccessOf(req: FastifyRequest): MerchantAccess {
  if (!req.merchantAccess) {
    throw new Error('merchantAccessOf() used on a route without requireMerchantPermission');
  }
  return req.merchantAccess;
}

export const requireAuth: preHandlerAsyncHookHandler = async (req) => {
  await authenticate(req);
};

/** Inline form of requireRole for handlers with more than one way in. */
export async function assertRole(req: FastifyRequest, roles: UserRole[]): Promise<AuthContext> {
  const auth = await authenticate(req);
  if (!roles.some((r) => auth.roles.includes(r))) {
    throw new AppError(ErrorCode.FORBIDDEN, 'Not allowed');
  }
  return auth;
}

/** Caller must have at least one of `roles`. */
export function requireRole(...roles: UserRole[]): preHandlerAsyncHookHandler {
  return async (req) => {
    await assertRole(req, roles);
  };
}

/**
 * /v1/admin/*: allowlisted IP (checked before anything else), an admin role, and a session
 * created through admin-web (which always requires TOTP).
 */
export function requireAdmin(...roles: UserRole[]): preHandlerAsyncHookHandler {
  const allowed: UserRole[] = roles.length ? roles : ['admin', 'super_admin'];
  return async (req) => {
    if (!req.server.isAdminIpAllowed(req.ip)) {
      req.log.warn({ ip: req.ip }, 'admin request from non-allowlisted IP');
      throw new AppError(ErrorCode.FORBIDDEN, 'Not allowed from this network');
    }
    const auth = await authenticate(req);
    if (auth.app !== 'admin-web' || !allowed.some((r) => auth.roles.includes(r))) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Not allowed');
    }
  };
}

/**
 * Merchant-scoped routes (`:merchantId` param). Loads the caller's staff membership fresh
 * from the DB on every request, so revoking a permission takes effect immediately.
 * With no permission argument, any active staff member passes.
 */
export function requireMerchantPermission(
  permission?: MerchantPermission,
): preHandlerAsyncHookHandler {
  return async (req) => {
    const auth = await authenticate(req);
    if (auth.app !== 'merchant' && auth.app !== 'merchant-web') {
      throw new AppError(ErrorCode.FORBIDDEN, 'Use the merchant app');
    }
    const merchantId = (req.params as { merchantId?: string }).merchantId;
    if (!merchantId) throw new Error('requireMerchantPermission needs a :merchantId route param');

    const staff = await req.server.db.merchantStaff.findUnique({
      where: { merchantId_userId: { merchantId, userId: auth.userId } },
      select: { id: true, rolePreset: true, permissions: true, isActive: true },
    });
    if (!staff?.isActive) {
      throw new AppError(ErrorCode.FORBIDDEN, 'You are not a member of this store');
    }
    const isOwner = staff.rolePreset === 'owner';
    // Owners always hold every permission, including ones added in later releases.
    const permissions = isOwner
      ? ALL_MERCHANT_PERMISSIONS
      : (staff.permissions as MerchantPermission[]);
    if (permission && !permissions.includes(permission)) {
      throw new AppError(ErrorCode.FORBIDDEN, `Missing permission: ${permission}`, { permission });
    }
    req.merchantAccess = { merchantId, staffId: staff.id, isOwner, permissions };
  };
}

/**
 * The resource must belong to the caller. `load` returns the owner's user id, or null when the
 * resource doesn't exist. Both "missing" and "someone else's" are 404 so ids can't be probed.
 */
export function requireOwnership(
  load: (req: FastifyRequest) => Promise<string | null>,
): preHandlerAsyncHookHandler {
  return async (req) => {
    const auth = await authenticate(req);
    const ownerId = await load(req);
    if (!ownerId || ownerId !== auth.userId) throw new AppError(ErrorCode.NOT_FOUND, 'Not found');
  };
}

export function setSessionCookies(
  reply: FastifyReply,
  s: { accessToken: string; refreshToken: string; accessExpiresAt: Date; refreshExpiresAt: Date },
): void {
  const env = reply.server.env;
  const base = {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'strict' as const,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
  void reply.setCookie(ACCESS_COOKIE, s.accessToken, {
    ...base,
    path: '/',
    expires: s.accessExpiresAt,
  });
  void reply.setCookie(REFRESH_COOKIE, s.refreshToken, {
    ...base,
    path: REFRESH_COOKIE_PATH,
    expires: s.refreshExpiresAt,
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  const env = reply.server.env;
  const domain = env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {};
  void reply.clearCookie(ACCESS_COOKIE, { path: '/', ...domain });
  void reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH, ...domain });
}

/** JWT signing/verification, request.auth, and the admin IP allowlist. */
export const authPlugin = fp(
  async (app) => {
    const env = app.env;
    await app.register(jwt, {
      secret: env.JWT_ACCESS_SECRET,
      sign: {
        algorithm: 'HS256',
        iss: env.JWT_ISSUER,
        // String form: fast-jwt treats a bare number as milliseconds.
        expiresIn: `${env.ACCESS_TOKEN_TTL_SECONDS}s`,
      },
      verify: { algorithms: ['HS256'], allowedIss: env.JWT_ISSUER },
    });
    app.decorate('isAdminIpAllowed', createIpAllowlist(env.ADMIN_IP_ALLOWLIST));
    app.decorateRequest('auth', null);
    app.decorateRequest('merchantAccess', null);
  },
  { name: 'auth', dependencies: ['infra', 'security'] },
);
