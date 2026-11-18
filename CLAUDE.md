# eBalangay — engineering brief

Secure all-in-one hyperlocal marketplace + delivery platform. Launch: Butuan City → Caraga → Mindanao. Tagline: "Need mo? eBalangay mo."

## Product
- 3 mobile apps: Customer, Rider, Merchant (phone + tablet + POS layouts).
- 2 web apps: Merchant web (business.ebalangay.ph), Admin web (admin.ebalangay.ph).
- Suppliers/wholesalers are merchants with `business_type = supplier | wholesaler`; wholesale features unlock by business_type. No separate supplier portal.
- All 5 apps talk ONLY to one backend API. Backend + PostgreSQL is the single source of truth.

## Monorepo (Turborepo + pnpm workspaces)
```
apps/api            Fastify + TS, Socket.io, BullMQ workers
apps/customer       Expo + Expo Router
apps/rider          Expo + Expo Router
apps/merchant       Expo + Expo Router (phone, tablet, POS)
apps/merchant-web   Next.js App Router
apps/admin-web      Next.js App Router
packages/shared     TS types, Zod schemas, enums (order statuses, roles, permissions), socket event names, money helpers
packages/api-client typed fetch client + TanStack Query hooks + socket hooks (used by all 5 apps)
packages/ui-native  shared RN components
packages/ui-web     shared web components (Tailwind + shadcn/ui, tables, charts, forms)
packages/i18n       en, fil, ceb strings (i18next; namespaces common/auth/orders/catalog/errors/notifications)
packages/config     shared ESLint flat config + Prettier config
```
- Design tokens live once in `@ebalangay/shared/design`; ui-native (NativeWind preset) and ui-web (`styles.css`, test-synced) consume them.
- Order state machine: `packages/shared/src/order-state-machine.ts` (`canTransition(from, to, actor, { orderType })`). apps/api enforces it.
- Root scripts the USER runs: `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:test:reset` (refuses any DB but `ebalangay_test`).

## Stack
- Node 20+, TypeScript strict, ESLint + Prettier.
- API: Fastify, Prisma, PostgreSQL + PostGIS, Redis, Socket.io (Redis adapter), BullMQ, Zod, Pino, Sentry.
- Mobile: Expo SDK (latest stable), Expo Router, TanStack Query, Zustand (local UI), expo-secure-store, expo-image, FlashList, react-native-maps, expo-location, expo-notifications, NativeWind.
- Web: Next.js App Router, TanStack Query, Tailwind, shadcn/ui, TanStack Table, Recharts, react-hook-form + Zod.
- Services: PayMongo (GCash, Maya, cards, BancNet, payouts), FCM, Semaphore SMS, Google Maps Platform, Cloudflare (DNS/CDN/WAF/rate limits), Cloudflare R2, Claude API, Sentry, Expo EAS.
- Local dev: local PostgreSQL **17 on port 5433** (`ebalangay_dev`, `ebalangay_test`; PostGIS + pg_trgm; app connects as non-superuser `ebalangay_app`) and Redis via **Memurai on 6379** (dev db 0, tests db 1). No Docker. Windows 10.
- Repo: https://github.com/scottlyndonwork-dev/ebalangaysystem.git (branch `main`).
- Toolchain pins: TypeScript ~6.0 (typescript-eslint doesn't support TS 7 yet), Prisma 7 (`prisma.config.ts`, adapter-pg, client generated to `apps/api/src/generated`, gitignored).
- Expo SDK 58 → React 19.3.0 (forced repo-wide via pnpm `overrides`), RN 0.88. NativeWind 4 needs Tailwind 3 (mobile); web uses Tailwind 4. TanStack Table v8, react-day-picker v9.
- ui-native/ui-web use `moduleResolution: bundler`. RN apps' tsconfig needs `customConditions: ["react-native-legacy-deep-imports"]` + `nativewind-env.d.ts` (RN 0.88 strict types can't take NativeWind `className`).
- Shared UI components take every user-facing string as a prop (rule 13); never hardcode text in packages.
- Prod: Railway Singapore (API, workers, Postgres w/ PITR + HA + PgBouncer, Redis); Vercel Singapore (web). Deploys only from GitHub Actions.

## Non-negotiable rules
1. Order status changes ONLY on the server, validated by the one order state machine (defined in packages/shared, enforced in apps/api). Apps request transitions; server validates.
2. All prices, fees, discounts, commissions, totals computed on the server. Never trust client amounts.
3. Money = integer centavos (BIGINT), never floats. Currency PHP. Times stored UTC, displayed Asia/Manila.
4. Every body/query/param validated with Zod schemas from packages/shared.
5. Every endpoint checks authN AND authZ (role + ownership + staff permission). PostgreSQL RLS as second layer on merchant-scoped tables.
6. Real-time: after commit → transactional outbox row → worker → Socket.io rooms + push. Socket events are hints; apps refetch from REST on reconnect. Each event carries entity id + version.
7. Socket rooms: `user:{id}`, `order:{id}`, `merchant:{id}`, `rider:{id}`, `zone:{id}`, `admin`. Joins are auth-checked server-side.
8. Rider GPS → Redis GEO, relayed to order rooms; trip breadcrumbs persisted to Postgres in batches, never every ping.
9. Payment calls use idempotency keys. PayMongo webhooks: verify signatures, process idempotently.
10. API versioned under `/v1`. No breaking changes to existing endpoints (add fields or `/v2`). Mobile sends `X-App-Version`; API can force-update below a minimum version.
11. Secrets only in env vars. Nothing secret in mobile bundles or the repo.
12. Mobile tokens in expo-secure-store; web uses httpOnly + Secure + SameSite cookies. Access token 15 min, rotating refresh tokens.
13. Every user-facing string goes through packages/i18n (en, fil, ceb).
14. Every list endpoint cursor-paginated. Every filterable column indexed.
15. Tests: unit (pricing, state machine, dispatch, wallet), integration for API routes (Vitest + Supertest vs test DB). Mobile: component tests for critical screens.
16. Data Privacy Act (RA 10173): minimum collection, encrypt ID documents, audit-log admin actions, account deletion + data export.

## Token discipline
- Search (grep/glob) before reading; read only needed ranges. Never read node_modules, dist, .next, build output, lockfiles, generated Prisma client.
- Don't re-read unchanged files. Don't print file contents/diffs back — short summaries only (files changed, check results, next step).
- Scope checks: `pnpm --filter <pkg> test|typecheck`, single test file while iterating; full `turbo run` only at phase end. Quiet reporters (`vitest --reporter=dot`, `--silent`); show only failures.
- No streaming dev servers/watchers in session; background only when verifying, then stop.
- One step at a time; don't scaffold later-phase features. Comments only for non-obvious logic.
- If a task is large, propose a split and a good point to /clear.

## Working style
- Before a phase: list files to create/change + plan, then build in small verified steps.
- Run installs, prisma generate, typecheck, lint, tests, builds yourself; fix failures and rerun.
- STOP AND ASK only for: (1) git (branches, commits, pushes, merges); (2) DB migrations (`prisma migrate dev/deploy`, seeds, any data/schema-changing SQL); (3) staging/production, deleting files/data, or packages outside the agreed stack. Show exact command + why, wait for "done", then verify.
- Schema changes: edit schema.prisma (+ raw SQL migrations when needed), run `prisma validate` + `prisma format`, then ask user to run the migration.
- Reuse shared/api-client/ui packages; never duplicate types or components across apps.
- If a request conflicts with these rules, follow the rules and say so.
- End of phase: full checks, report results (passed / skipped + why), acceptance checklist pass/fail, and git commands with suggested branch name + commit message for the user to run.
