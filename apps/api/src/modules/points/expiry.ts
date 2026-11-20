import type { Db } from '../../db.js';

export const POINTS_EXPIRY_BATCH_SIZE = 500;

export interface PointsExpiryResult {
  accounts: number;
  points: number;
}

/**
 * Redemptions consume the oldest points first (FIFO), so whatever balance exceeds the credits
 * that are still valid (unexpired or never-expiring) is made of expired points. Writing the
 * `expire` debit brings the two back in line, which makes reruns no-ops.
 */
export async function expirePoints(db: Db, now = new Date()): Promise<PointsExpiryResult> {
  const result: PointsExpiryResult = { accounts: 0, points: 0 };
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const candidates = await db.$queryRaw<{ id: string }[]>`
      SELECT a.id FROM points_accounts a
      WHERE a.id > ${after}::uuid
        AND a.balance > 0
        AND EXISTS (
          SELECT 1 FROM points_transactions t
          WHERE t.account_id = a.id AND t.points > 0 AND t.expires_at <= ${now}::timestamptz
        )
      ORDER BY a.id
      LIMIT ${POINTS_EXPIRY_BATCH_SIZE}`;
    for (const { id } of candidates) {
      const expired = await db.$transaction(async (tx) => {
        // Row lock: a checkout redeeming points waits for us (and vice versa).
        const [row] = await tx.$queryRaw<{ balance: number; live: number }[]>`
          SELECT a.balance,
            COALESCE((
              SELECT sum(t.points) FROM points_transactions t
              WHERE t.account_id = a.id AND t.points > 0
                AND (t.expires_at IS NULL OR t.expires_at > ${now}::timestamptz)
            ), 0)::int AS live
          FROM points_accounts a WHERE a.id = ${id}::uuid
          FOR UPDATE OF a`;
        const points = row ? row.balance - row.live : 0;
        if (points <= 0) return 0;
        const account = await tx.pointsAccount.update({
          where: { id },
          data: { balance: { decrement: points } },
        });
        await tx.pointsTransaction.create({
          data: {
            accountId: id,
            type: 'expire',
            points: -points,
            balanceAfter: account.balance,
            description: 'Points expired',
            createdAt: now,
          },
        });
        return points;
      });
      if (expired > 0) {
        result.accounts++;
        result.points += expired;
      }
    }
    if (candidates.length < POINTS_EXPIRY_BATCH_SIZE) break;
    after = candidates.at(-1)?.id ?? after;
  }
  return result;
}
