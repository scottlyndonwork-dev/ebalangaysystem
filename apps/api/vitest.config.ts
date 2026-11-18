import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one test database; run files serially.
    fileParallelism: false,
    setupFiles: ['test/setup.ts'],
  },
});
