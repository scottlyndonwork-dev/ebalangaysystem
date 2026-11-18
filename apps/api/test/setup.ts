import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load apps/api/.env.test (gitignored) when present; CI sets the variables directly.
const envFile = resolve(import.meta.dirname, '../.env.test');
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';
