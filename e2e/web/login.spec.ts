import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * Persian is requested explicitly: the documented locale chain puts `ui_locales` first and
 * the browser's `Accept-Language` second, so without it the run would depend on the test
 * browser's language once a client enables more than one locale (docs/localization.md 3).
 */
const loginUrl =
  '/?client_id=admin-panel&ui_locales=fa-IR&return_to=%2Foauth2%2Fauthorize%3Fclient_id%3Dadmin-panel';

test.describe('hosted login', () => {
  test('renders an RTL Persian form without critical accessibility violations', async ({
    page,
  }) => {
    await page.goto(loginUrl);

    await expect(page.getByTestId('idpn-root')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();
    await expect(page.getByLabel('ایمیل یا نام کاربری')).toBeVisible();
    await expect(page.getByLabel('رمز عبور')).toBeVisible();
    await expect(page.getByLabel('ایمیل یا نام کاربری')).toBeFocused();

    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations
      .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
      .map((violation) => `${violation.id}: ${violation.help}`);

    expect(blocking).toEqual([]);
  });

  test('validates empty fields, links errors and keeps focus usable by keyboard', async ({
    page,
  }) => {
    await page.goto(loginUrl);

    await page.getByRole('button', { name: 'ورود' }).click();

    await expect(page.getByText('ایمیل یا نام کاربری را وارد کنید.')).toBeVisible();
    await expect(page.getByLabel('ایمیل یا نام کاربری')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('ایمیل یا نام کاربری')).toHaveAttribute(
      'aria-describedby',
      'identifier-error',
    );

    await page.getByLabel('ایمیل یا نام کاربری').fill('admin');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('رمز عبور')).toBeFocused();
  });

  test('shows a generic error for invalid credentials and never navigates', async ({ page }) => {
    await page.route('**/api/v1/login', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_credentials', message: 'invalid' }),
      }),
    );

    await page.goto(loginUrl);
    await page.getByLabel('ایمیل یا نام کاربری').fill('sara@example.com');
    await page.getByLabel('رمز عبور').fill('wrong-password');
    await page.getByRole('button', { name: 'ورود' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('نام کاربری یا رمز عبور نادرست است.');
    await expect(alert).not.toContainText('وجود ندارد');
    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();
  });

  test('navigates to the authorize endpoint after a successful login', async ({ page }) => {
    await page.route('**/api/v1/login', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, redirectTo: '/oauth2/authorize?client_id=admin-panel' }),
      }),
    );
    await page.route('**/oauth2/authorize**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>authorized</h1>' }),
    );

    await page.goto(loginUrl);
    await page.getByLabel('ایمیل یا نام کاربری').fill('sara@example.com');
    await page.getByLabel('رمز عبور').fill('a-very-long-password');
    await page.getByRole('button', { name: 'ورود' }).click();

    await page.waitForURL('**/oauth2/authorize**');
    await expect(page.getByRole('heading', { name: 'authorized' })).toBeVisible();
  });

  test('keeps the UI usable on a mobile viewport without horizontal scrolling', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(loginUrl);

    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ورود' })).toBeInViewport();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'critical' || violation.impact === 'serious',
      ),
    ).toEqual([]);
  });

  test('stores no token in browser-readable storage after signing in', async ({ page }) => {
    // The property is only meaningful after a real sign-in: reading storage on a blank form
    // could never fail (card #18 finding 5).
    await page.route('**/api/v1/login', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'set-cookie': 'idpn_session=session-abc; HttpOnly; Path=/; SameSite=Lax' },
        body: JSON.stringify({ ok: true, redirectTo: '/dashboard' }),
      }),
    );

    // The successful login navigates to the returned target; serve it so the assertion runs
    // on the destination page instead of racing the navigation.
    await page.route('**/dashboard', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>ok</title>' }),
    );

    await page.goto(loginUrl);
    const response = page.waitForResponse('**/api/v1/login');
    await page.getByLabel('ایمیل یا نام کاربری').fill('admin');
    await page.getByLabel('رمز عبور').fill('a-very-long-password');
    await page.getByRole('button', { name: 'ورود', exact: true }).click();
    await response;
    await page.waitForURL('**/dashboard');

    const storage = await page.evaluate(() => ({
      localStorage: { ...localStorage },
      sessionStorage: { ...sessionStorage },
      cookie: document.cookie,
    }));

    const serialized = JSON.stringify(storage).toLowerCase();
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');
    expect(serialized).not.toContain('id_token');
    // The session cookie is HttpOnly, so script cannot read it at all.
    expect(storage.cookie).not.toContain('idpn_session');
  });
});
