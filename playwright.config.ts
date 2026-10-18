import { defineConfig, devices } from '@playwright/test';

const API_PORT = Number(process.env.E2E_PORT ?? 3100);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5180);
const BFF_PORT = Number(process.env.E2E_BFF_PORT ?? 3200);
const apiURL = `http://127.0.0.1:${API_PORT}`;
const webURL = `http://127.0.0.1:${WEB_PORT}`;
const bffURL = `http://127.0.0.1:${BFF_PORT}`;
const hostURL = 'http://127.0.0.1:5176';
const isCI = process.env.CI === 'true';
const databaseURL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/idpn';
const redisURL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const bffClientId = process.env.E2E_BFF_CLIENT_ID ?? 'sample-bff';
const bffClientSecret = process.env.E2E_BFF_CLIENT_SECRET ?? 'e2e-bff-client-secret';
const e2eUserIdentifier = process.env.E2E_USER_IDENTIFIER ?? 'user@example.com';
const e2eUserPassword = process.env.E2E_USER_PASSWORD ?? 'e2e-user-password-123';

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
    {
      name: 'bff-chromium',
      testMatch: 'bff/*.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: bffURL },
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
        HOSTED_UI_URL: webURL,
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
    {
      // Seeds the sample BFF client and a login credential, then starts the sample app.
      command: 'pnpm --filter @idpn/api run seed:e2e && pnpm --filter @idpn/example-bff run dev',
      url: `${bffURL}/healthz`,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      env: {
        DATABASE_URL: databaseURL,
        REDIS_URL: redisURL,
        IDP_URL: apiURL,
        HOSTED_UI_URL: webURL,
        BFF_HOST: '127.0.0.1',
        BFF_PORT: String(BFF_PORT),
        BFF_PUBLIC_URL: bffURL,
        BFF_CLIENT_ID: bffClientId,
        BFF_CLIENT_SECRET: bffClientSecret,
        E2E_BFF_CLIENT_ID: bffClientId,
        E2E_BFF_CLIENT_SECRET: bffClientSecret,
        E2E_BFF_REDIRECT_URI: `${bffURL}/auth/callback`,
        E2E_BFF_POST_LOGOUT_URI: `${bffURL}/signed-out`,
        E2E_USER_IDENTIFIER: e2eUserIdentifier,
        E2E_USER_PASSWORD: e2eUserPassword,
      },
    },
  ],
});
