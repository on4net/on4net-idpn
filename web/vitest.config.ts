import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@idpn/mfe-sdk': fileURLToPath(new URL('../packages/mfe-sdk/src/index.ts', import.meta.url)),
      '@idpn/contracts/theme': fileURLToPath(
        new URL('../packages/contracts/src/theme.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx'],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
