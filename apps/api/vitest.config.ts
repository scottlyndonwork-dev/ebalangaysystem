import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one test database; run files serially.
    fileParallelism: false,
    // Password tests run real scrypt (~32 MiB, by design); give them headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['test/setup.ts'],
  },
});
