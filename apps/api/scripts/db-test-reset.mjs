// Resets ONLY the ebalangay_test database: drops all data, re-applies migrations.
// Usage (from repo root): pnpm db:test:reset
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const apiDir = resolve(import.meta.dirname, '..');
const envFile = resolve(apiDir, '.env.test');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error('TEST_DATABASE_URL is not set (see apps/api/.env.example).');
  process.exit(1);
}
const dbName = new URL(url).pathname.replace(/^\//, '');
if (dbName !== 'ebalangay_test') {
  console.error(`Refusing to reset "${dbName}": db:test:reset only targets ebalangay_test.`);
  process.exit(1);
}

const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'reset', '--force'], {
  cwd: apiDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  // PRISMA_SKIP_DOTENV stops prisma.config.ts from loading the dev .env over this URL.
  env: { ...process.env, DATABASE_URL: url, PRISMA_SKIP_DOTENV: '1' },
});
process.exit(result.status ?? 1);
