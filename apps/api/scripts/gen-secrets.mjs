// Appends any missing auth secrets to apps/api/.env and .env.test with fresh random values.
// Existing keys are never changed and values are never printed. Usage: node scripts/gen-secrets.mjs
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const gen = {
  JWT_ACCESS_SECRET: () => randomBytes(48).toString('base64url'),
  OTP_PEPPER: () => randomBytes(48).toString('base64url'),
  COOKIE_SECRET: () => randomBytes(48).toString('base64url'),
  DATA_ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
};

for (const name of ['.env', '.env.test']) {
  const file = resolve(import.meta.dirname, '..', name);
  if (!existsSync(file)) {
    console.log(`skip ${name} (not found)`);
    continue;
  }
  const text = readFileSync(file, 'utf8');
  const has = (key) => new RegExp(`^${key}=.+`, 'm').test(text);
  const added = Object.entries(gen).filter(([key]) => !has(key));
  if (added.length) {
    const lines = added.map(([key, make]) => `${key}=${make()}`).join('\n');
    appendFileSync(
      file,
      `${text.endsWith('\n') ? '' : '\n'}\n# Added by scripts/gen-secrets.mjs\n${lines}\n`,
    );
  }
  console.log(`${name}: added ${added.map(([k]) => k).join(', ') || 'nothing (all present)'}`);
}
