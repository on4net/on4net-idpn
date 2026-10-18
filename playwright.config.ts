import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: process.env.CI === 'true' ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @idpn/api dev',
    url: `${baseURL}/healthz`,
    reuseExistingServer: process.env.CI !== 'true',
    timeout: 120_000,
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      APP_URL: baseURL,
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://idpn:idpn@127.0.0.1:5432/idpn',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      SESSION_SECRET: process.env.SESSION_SECRET ?? 'e2e-session-secret-at-least-32-characters',
    },
  },
});
