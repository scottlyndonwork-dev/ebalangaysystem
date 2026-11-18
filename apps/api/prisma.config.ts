import { defineConfig } from 'prisma/config';

// DATABASE_URL is read from the environment (apps/api/.env is loaded by the scripts that need it).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
