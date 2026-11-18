import type { FastifyRequest } from 'fastify';
import type { Db, Tx } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';

export interface AuditEntry {
  /** dot.separated verb, e.g. auth.login, auth.totp.enable, merchant.staff.update */
  action: string;
  actorUserId?: string | null;
  actorRole?: string | null;
  targetType?: string;
  targetId?: string;
  merchantId?: string;
  /** Never put secrets, codes, tokens or full card/account numbers here. */
  metadata?: Prisma.InputJsonObject;
}

/**
 * Append-only audit trail (a DB trigger rejects UPDATE/DELETE on audit_logs). Pass the
 * transaction client when the audited change is transactional so both commit together.
 */
export async function writeAudit(
  db: Db | Tx,
  req: FastifyRequest | null,
  entry: AuditEntry,
): Promise<void> {
  const ua = req?.headers['user-agent'];
  await db.auditLog.create({
    data: {
      action: entry.action,
      actorUserId: entry.actorUserId ?? req?.auth?.userId ?? null,
      actorRole: entry.actorRole ?? req?.auth?.roles.join(',') ?? null,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      merchantId: entry.merchantId ?? null,
      ip: req?.ip ?? null,
      userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
      metadata: entry.metadata ?? {},
    },
  });
}
