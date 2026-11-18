# eBalangay API

Fastify + TypeScript, Prisma 7 (PostgreSQL 17 + PostGIS), Redis. All five apps talk only to this API under `/v1`.

- `pnpm --filter @ebalangay/api dev`: run locally (needs `apps/api/.env`, see `.env.example`).
- `pnpm --filter @ebalangay/api test`: integration tests against `ebalangay_test` (needs `.env.test`).
- From the repo root: `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:test:reset` (test DB only).
