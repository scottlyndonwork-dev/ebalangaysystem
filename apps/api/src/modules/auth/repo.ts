import type { Db, Tx } from '../../db.js';
import type { AppPlatform as DbAppPlatform } from '../../generated/prisma/client.js';

/** Data access for OTPs, refresh tokens and devices. No business rules here. */
export function authRepo(db: Db) {
  return {
    countOtpsSince(where: { phone: string } | { ip: string }, since: Date) {
      return db.otpRequest.count({ where: { ...where, createdAt: { gte: since } } });
    },
    oldestOtpSince(where: { phone: string } | { ip: string }, since: Date) {
      return db.otpRequest.findFirst({
        where: { ...where, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
    },
    latestOtp(phone: string) {
      return db.otpRequest.findFirst({ where: { phone }, orderBy: { createdAt: 'desc' } });
    },
    activeOtp(phone: string, now: Date) {
      return db.otpRequest.findFirst({
        where: { phone, consumedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
      });
    },
    /** A new code supersedes any earlier unexpired code for the phone. */
    async replaceOtp(data: { phone: string; codeHash: string; ip: string; expiresAt: Date }) {
      const now = new Date();
      return db.$transaction(async (tx) => {
        await tx.otpRequest.updateMany({
          where: { phone: data.phone, consumedAt: null, expiresAt: { gt: now } },
          data: { expiresAt: now },
        });
        return tx.otpRequest.create({ data });
      });
    },
    expireOtp(id: string) {
      return db.otpRequest.update({ where: { id }, data: { expiresAt: new Date() } });
    },
    /** Atomically counts an attempt; false once the limit is reached. */
    async recordOtpAttempt(id: string, maxAttempts: number) {
      const r = await db.otpRequest.updateMany({
        where: { id, consumedAt: null, attempts: { lt: maxAttempts } },
        data: { attempts: { increment: 1 } },
      });
      return r.count === 1;
    },
    /** Single use: only one concurrent verify can consume a code. */
    async consumeOtp(id: string) {
      const r = await db.otpRequest.updateMany({
        where: { id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      return r.count === 1;
    },

    findUserByPhone: (phone: string) => db.user.findUnique({ where: { phone } }),
    findUserByEmail: (email: string) => db.user.findUnique({ where: { email } }),
    findUser: (id: string) => db.user.findUnique({ where: { id } }),

    createRefreshToken(
      tx: Db | Tx,
      data: {
        userId: string;
        familyId: string;
        tokenHash: string;
        app: DbAppPlatform;
        deviceId: string | null;
        userAgent: string | null;
        ip: string | null;
        expiresAt: Date;
      },
    ) {
      return tx.refreshToken.create({ data });
    },
    findRefreshToken: (tokenHash: string) =>
      db.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } }),
    /** Marks the token used; false if another request already rotated or revoked it. */
    async claimRefreshToken(tx: Tx, id: string) {
      const r = await tx.refreshToken.updateMany({
        where: { id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: new Date() },
      });
      return r.count === 1;
    },
    revokeFamily(familyId: string, reason: string) {
      return db.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
    },
    clearDevicePushToken(userId: string, deviceId: string) {
      return db.userDevice.updateMany({ where: { userId, deviceId }, data: { pushToken: null } });
    },
  };
}

export type AuthRepo = ReturnType<typeof authRepo>;
