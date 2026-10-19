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
const secondClientId = process.env.E2E_SECOND_CLIENT_ID ?? 'sample-bff-b';
const secondRedirectUri =
  process.env.E2E_SECOND_REDIRECT_URI ?? 'http://127.0.0.1:3201/auth/callback';

// Browser specs need the IdP origin (the app under test is the BFF host) and the second
// app's client configuration; expose them to the test runner, not only to web servers.
process.env.E2E_IDP_URL = process.env.E2E_IDP_URL ?? apiURL;
process.env.E2E_WEB_URL = process.env.E2E_WEB_URL ?? webURL;
process.env.E2E_SECOND_CLIENT_ID = secondClientId;
process.env.E2E_SECOND_REDIRECT_URI = secondRedirectUri;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'on-first-retry',
  },
  // Vite optimizes the federated dependencies on the first cold request; a 5s default
  // makes the first module mount flaky on slower machines. Assertions stay unchanged.
  expect: { timeout: 15_000 },
  projects: [
    {
      name: 'api-chromium',
      testMatch: ['health.spec.ts', 'admin/*.spec.ts'],
      use: { ...devices['Desktop Chrome'], baseURL: apiURL },
    },
    {
      name: 'web-chromium',
      testMatch: ['web/login.spec.ts', 'web/rtl.spec.ts'],
      use: { ...devices['Desktop Chrome'], baseURL: webURL },
    },
    {
      name: 'mfe-chromium',
      testMatch: 'web/isolation.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: webURL },
    },
    {
      name: 'wc-host-chromium',
      testMatch: 'web/web-component-host.spec.ts',
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
      // `dev:e2e` builds the Web Component bundle first: the vanilla host in
      // `web/host` loads the real `dist-wc/web-component.js`, not the TS source.
      command: 'pnpm --filter @idpn/web run dev:e2e',
      url: webURL,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      env: {
        VITE_PORT: String(WEB_PORT),
        VITE_API_PROXY: apiURL,
        // Vanilla host configuration (build-time only, never from the URL).
        VITE_IDPN_CLIENT_ID: 'app-a',
        VITE_IDPN_API_BASE_URL: '',
        VITE_IDPN_LOGIN_URL: `${webURL}/oauth2/authorize`,
        VITE_IDPN_LOCALE: 'fa-IR',
        VITE_IDPN_DIR: 'rtl',
        VITE_IDPN_MODULE: 'all',
        VITE_IDPN_THEME: JSON.stringify({ primary: '#0057b8' }),
      },
    },
    {
      command: 'pnpm --filter @idpn/web dev:host',
      url: hostURL,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      env: {
        // Host configuration is build-time only; the E2E suite asserts these values are
        // what the remotes receive, and that a query string cannot override them.
        VITE_IDPN_CLIENT_ID: 'app-a',
        VITE_IDPN_API_BASE_URL: '',
        VITE_IDPN_LOGIN_URL: `${webURL}/oauth2/authorize`,
        VITE_IDPN_LOGIN_CONTEXT: 'admin',
        VITE_IDPN_LOCALE: 'fa-IR',
        VITE_IDPN_DIR: 'auto',
        VITE_IDPN_MODULE: 'all',
        VITE_IDPN_THEME: JSON.stringify({ primary: '#0057b8' }),
        IDPN_REMOTE_ENTRY: '/remote/remoteEntry.js',
      },
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
        E2E_SECOND_CLIENT_ID: secondClientId,
        E2E_SECOND_REDIRECT_URI: secondRedirectUri,
      },
    },
  ],
});
