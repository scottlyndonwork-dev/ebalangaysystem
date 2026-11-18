import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer auto-loads .env; CI provides real env vars instead.
// scripts/db-test-reset.mjs sets PRISMA_SKIP_DOTENV so the dev .env never overrides the test URL.
if (!process.env.PRISMA_SKIP_DOTENV && existsSync('.env')) process.loadEnvFile('.env');

// The shadow DB is pre-created with PostGIS by a superuser, because ebalangay_app cannot
// create databases or install extensions itself.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    ...(process.env.SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
      : {}),
  },
});
