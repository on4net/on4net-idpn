import { defineConfig, devices } from '@playwright/test';

const API_PORT = Number(process.env.E2E_PORT ?? 3100);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5180);
const apiURL = `http://127.0.0.1:${API_PORT}`;
const webURL = `http://127.0.0.1:${WEB_PORT}`;
const hostURL = 'http://127.0.0.1:5176';
const isCI = process.env.CI === 'true';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'api-chromium',
      testMatch: 'health.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: apiURL },
    },
    {
      name: 'web-chromium',
      testMatch: 'web/login.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: webURL },
    },
    {
      name: 'mfe-chromium',
      testMatch: 'web/isolation.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: webURL },
    },
    {
      name: 'mf-chromium',
      testMatch: 'web/mf-host.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: hostURL },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @idpn/api dev',
      url: `${apiURL}/healthz`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(API_PORT),
        APP_URL: apiURL,
        DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://idpn:idpn@127.0.0.1:5432/idpn',
        REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
        SESSION_SECRET: process.env.SESSION_SECRET ?? 'e2e-session-secret-at-least-32-characters',
      },
    },
    {
      command: 'pnpm --filter @idpn/web dev',
      url: webURL,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        VITE_PORT: String(WEB_PORT),
        VITE_API_PROXY: apiURL,
      },
    },
    {
      command: 'pnpm --filter @idpn/web dev:host',
      url: hostURL,
      reuseExistingServer: !isCI,
      timeout: 180_000,
    },
  ],
});
