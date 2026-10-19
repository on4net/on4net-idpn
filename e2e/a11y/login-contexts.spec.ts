import { expect, test, type Page } from '@playwright/test';

import { expectNoBlockingViolations, installUiFixtures } from '../support/ui-fixtures';

/**
 * Context selection and context branding on the Hosted Auth UI
 * (`docs/login-contexts.md` 4.2 and 7.1, docs/design-system.md 5.1).
 *
 * The public config is mocked at the route layer: the selector only ever offers the active
 * contexts the API published, and every provider list is filtered by the context's
 * `login_methods`.
 */

const AUTHORIZE =
  '/oauth2/authorize?client_id=admin-panel&scope=openid&state=state-1&nonce=nonce-1' +
  '&code_challenge=challenge-1&code_challenge_method=S256';

const loginUrl = (locale: 'fa-IR' | 'en-US', multi: boolean): string =>
  `/?client_id=admin-panel&ui_locales=${encodeURIComponent(locale)}` +
  `${multi ? '&login_request=req-1' : ''}&return_to=${encodeURIComponent(AUTHORIZE)}`;

const returnToParams = async (page: Page): Promise<URLSearchParams> => {
  const search = await page.evaluate(() => window.location.search);
  const returnTo = new URLSearchParams(search).get('return_to') ?? '';
  return new URL(returnTo, 'http://idp.test').searchParams;
};

test.describe('hosted login context selector', () => {
  test('two-context client in Persian RTL: selector, branding and allowed providers', async ({
    page,
  }) => {
    await installUiFixtures(page, { contexts: 'multi' });
    await page.goto(loginUrl('fa-IR', true));

    const root = page.getByTestId('idpn-root');
    await expect(root).toHaveAttribute('dir', 'rtl');
    await expect(root).toHaveAttribute('lang', 'fa-IR');

    const selector = page.getByTestId('login-context-selector');
    await expect(selector.getByText('انتخاب روش ورود')).toBeVisible();
    await expect(selector.getByRole('radio', { name: /Customer team/ })).toBeChecked();
    await expect(selector.getByRole('radio', { name: /Customer admin/ })).not.toBeChecked();

    // The default context brands the page and filters the provider list.
    await expect(page.getByTestId('login-context-panel')).toHaveAttribute(
      'data-login-context',
      'customer-team',
    );
    await expect(page.getByTestId('login-context-panel')).toContainText('Day-to-day operations');
    await expect(page.getByText('می‌توانید حساب کاربری جدید بسازید.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'ادامه با Facebook' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Google/ })).toHaveCount(0);

    const identifier = page.getByLabel('ایمیل یا نام کاربری');
    await identifier.fill('sara@example.com');

    await expectNoBlockingViolations(page);

    // Switching context keeps the typed value and re-brands the page without a reload.
    await selector.getByRole('radio', { name: /Customer admin/ }).check();
    await expect(selector.getByRole('radio', { name: /Customer admin/ })).toBeChecked();
    await expect(identifier).toHaveValue('sara@example.com');

    const panel = page.getByTestId('login-context-panel');
    await expect(panel).toHaveAttribute('data-login-context', 'customer-admin');
    await expect(panel.getByText('Customer admin console')).toBeVisible();
    await expect(panel.locator('img')).toHaveAttribute(
      'src',
      'https://assets.idpn.test/customer-admin.svg',
    );
    await expect(page.getByText('برای این روش ورود، تأیید دومرحله‌ای الزامی است.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'ادامه با Google' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Facebook/ })).toHaveCount(0);
    await expect
      .poll(() =>
        page
          .getByTestId('idpn-root')
          .evaluate((element) =>
            getComputedStyle(element).getPropertyValue('--idpn-primary').trim(),
          ),
      )
      .toBe('#0f766e');

    // The authorize request is preserved and now carries the selected context.
    const params = await page.evaluate(() => window.location.search);
    expect(new URLSearchParams(params).get('login_context')).toBe('customer-admin');
    expect(new URLSearchParams(params).get('login_request')).toBe('req-1');
    const bound = await returnToParams(page);
    expect(bound.get('login_context')).toBe('customer-admin');
    expect(bound.get('state')).toBe('state-1');
    expect(bound.get('nonce')).toBe('nonce-1');
    expect(bound.get('code_challenge')).toBe('challenge-1');
    expect(bound.get('code_challenge_method')).toBe('S256');
    expect(`${params}${bound.toString()}`).not.toMatch(/token|secret/i);

    await expectNoBlockingViolations(page);
  });

  test('two-context client in English LTR keeps direction and translations', async ({ page }) => {
    await installUiFixtures(page, { contexts: 'multi', locale: 'en-US' });
    await page.goto(loginUrl('en-US', true));

    const root = page.getByTestId('idpn-root');
    await expect(root).toHaveAttribute('dir', 'ltr');
    await expect(root).toHaveAttribute('lang', 'en-US');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    const selector = page.getByTestId('login-context-selector');
    await expect(selector.getByText('Choose how to sign in')).toBeVisible();
    await expect(selector.getByRole('radio', { name: /Customer team/ })).toBeChecked();
    await expect(page.getByText('You can create a new account.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Facebook' })).toBeVisible();

    await expectNoBlockingViolations(page);

    await selector.getByRole('radio', { name: /Customer admin/ }).check();
    await expect(page.getByText('Customer admin console')).toBeVisible();
    await expect(page.getByText('This sign-in option requires a second factor.')).toBeVisible();
    await expect(page.getByText('Accounts are created by invitation only.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(root).toHaveAttribute('dir', 'ltr');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await expectNoBlockingViolations(page);
  });

  test('single-context client skips the selector and keeps the plain login card', async ({
    page,
  }) => {
    await installUiFixtures(page);
    await page.goto(loginUrl('fa-IR', false));

    await expect(page.getByTestId('login-context-selector')).toHaveCount(0);
    await expect(page.getByTestId('login-context-panel')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();

    const bound = await returnToParams(page);
    expect(bound.get('state')).toBe('state-1');

    await expectNoBlockingViolations(page);
  });
});
