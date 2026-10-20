import { healthResponseSchema } from '@idpn/contracts';
import { expect, test } from '@playwright/test';

test('serves a contract-valid health response in Chromium', async ({ page, request }) => {
  const response = await page.goto('/healthz');

  expect(response?.status()).toBe(200);

  const body: unknown = await response?.json();
  expect(healthResponseSchema.parse(body)).toEqual({
    status: 'ok',
    service: 'on4net-idpn-api',
  });

  await expect(page.locator('body')).toContainText('on4net-idpn-api');

  const apiResponse = await request.get('/healthz');
  expect(apiResponse.ok()).toBe(true);
  expect(apiResponse.headers()['x-content-type-options']).toBe('nosniff');
  expect(apiResponse.headers()['referrer-policy']).toBe('no-referrer');
});
