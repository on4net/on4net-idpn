import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests start real PostgreSQL containers.
    hookTimeout: 240_000,
    testTimeout: 120_000,
  },
});
