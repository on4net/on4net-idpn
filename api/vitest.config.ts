import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests start real PostgreSQL and Redis containers; running files
    // sequentially keeps container startup predictable on slower/CI machines.
    fileParallelism: false,
    hookTimeout: 300_000,
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/generated/**', 'src/**/*.test.ts'],
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
    },
  },
});
