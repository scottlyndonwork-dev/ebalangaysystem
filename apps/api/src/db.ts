import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from './generated/prisma/client.js';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

export function createDb(databaseUrl: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

/**
 * Run `fn` in a transaction scoped to one merchant: Postgres RLS hides and blocks every other
 * merchant's rows. Use for all merchant-app/merchant-web routes (second layer behind authZ).
 */
export async function withMerchantContext<T>(
  db: Db,
  merchantId: string,
  fn: (tx: Tx) => Promise<T>,
  options?: { timeout?: number },
): Promise<T> {
  return db.$transaction(async (tx) => {
    // `true` = transaction-local, so pooled connections never leak the setting.
    await tx.$executeRaw`SELECT set_config('app.current_merchant_id', ${merchantId}, true)`;
    return fn(tx);
  }, options);
}

const REQUIRED_EXTENSIONS = ['postgis', 'pg_trgm'] as const;

/** Throws a clear, actionable error if PostGIS or pg_trgm is missing from the database. */
export async function assertExtensions(db: Db): Promise<void> {
  const rows = await db.$queryRaw<{ extname: string }[]>`SELECT extname FROM pg_extension`;
  const installed = new Set(rows.map((r) => r.extname));
  const missing = REQUIRED_EXTENSIONS.filter((e) => !installed.has(e));
  if (missing.length) {
    throw new Error(
      `Database is missing extension(s): ${missing.join(', ')}.\n` +
        `Connect as a superuser (e.g. psql -U postgres -p 5433 -d <db>) and run:\n` +
        missing.map((e) => `  CREATE EXTENSION IF NOT EXISTS ${e};`).join('\n'),
    );
  }
}
