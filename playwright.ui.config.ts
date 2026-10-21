import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-only configuration for the accessibility and visual suites.
 *
 * Unlike `playwright.config.ts`, this config starts only the web dev server: every IdP
 * call is mocked at the route layer (`e2e/support/ui-fixtures.ts`), so the suites need no
 * PostgreSQL, Redis, social provider credentials or API/BFF process. Use it in CI jobs
 * that gate the shared UI.
 */

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5180);
const webURL = `http://127.0.0.1:${WEB_PORT}`;
const isCI = process.env.CI === 'true';

const uiProject = {
  use: {
    ...devices['Desktop Chrome'],
    baseURL: webURL,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light' as const,
    reducedMotion: 'reduce' as const,
    timezoneId: 'UTC',
    locale: 'fa-IR',
  },
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  expect: {
    timeout: 15_000,
    // `maxDiffPixelRatio` stays at 1 %: on this host a freshly generated baseline differs from
    // its own re-run by ~1 % of pixels (system font fallback, no webfont is shipped), so a
    // tighter budget is flaky rather than stricter. The per-pixel colour tolerance is halved
    // to 0.1 so a token/colour change is still caught inside that budget (card #56 finding 3).
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.01,
      threshold: 0.1,
    },
  },
  snapshotPathTemplate: '{testDir}/visual/__screenshots__/{platform}/{arg}{ext}',
  projects: [
    {
      name: 'a11y-chromium',
      testMatch: 'a11y/*.spec.ts',
      ...uiProject,
    },
    {
      name: 'visual-chromium',
      testMatch: 'visual/*.spec.ts',
      ...uiProject,
    },
  ],
  webServer: [
    {
      // The harness page (`web/harness`) is served by Vite in development; `vite build`
      // only bundles `index.html`, so it never reaches production.
      command: 'pnpm --filter @idpn/web dev',
      url: webURL,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      env: {
        VITE_PORT: String(WEB_PORT),
        // Route interception answers every IdP call; the proxy target is intentionally unused.
        VITE_API_PROXY: 'http://127.0.0.1:9',
      },
    },
  ],
});
