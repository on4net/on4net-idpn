import { expect, test } from '@playwright/test';

/**
 * The Hosted UI is served by Vite in E2E, but the header set comes from the same
 * `buildSecurityHeaders` module used by the documented production deployment
 * (`deploy/security/`), so this asserts the real policy the browser receives.
 */
test('Hosted UI serves the documented CSP and hardening headers', async ({ request }) => {
  const response = await request.get('/');

  expect(response.ok()).toBe(true);
  const headers = response.headers();
  const csp = headers['content-security-policy'] ?? '';

  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).not.toContain('*');
  expect(headers['content-security-policy-report-only']).toContain(
    "require-trusted-types-for 'script'",
  );
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('no-referrer');
});
