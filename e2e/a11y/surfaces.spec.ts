import { expect, test, type Page } from '@playwright/test';

import { expectNoBlockingViolations, installUiFixtures } from '../support/ui-fixtures';

/**
 * Accessibility gate for every shipped shadcn/ui surface (docs/testing.md 8, docs/design-system.md 9).
 *
 * The bar is the one in the acceptance criteria: no Critical/Serious axe findings.
 * Playwright is the chosen layer because it runs axe in a real browser where layout,
 * contrast, portalled overlays and focus behaviour exist; jsdom cannot evaluate contrast
 * or place Radix portals.
 */

const LOGIN_PATH =
  '/?client_id=admin-panel&return_to=%2Foauth2%2Fauthorize%3Fclient_id%3Dadmin-panel';

const hosted = (locale: 'fa-IR' | 'en-US'): string =>
  `${LOGIN_PATH}&ui_locales=${encodeURIComponent(locale)}`;

const harness = (
  surface: 'account' | 'user-management' | 'admin',
  locale: 'fa-IR' | 'en-US',
): string => `/harness/?surface=${surface}&locale=${encodeURIComponent(locale)}`;

/** Applies the documented dark-mode class directly on the shared root (no product toggle yet). */
async function useDarkTokens(page: Page): Promise<void> {
  // Disable theme transitions so axe reads the settled dark tokens, not an intermediate frame.
  await page.addStyleTag({
    content: '*,*::before,*::after{transition:none!important;animation:none!important}',
  });
  await page
    .locator('.idpn-root')
    .first()
    .evaluate((element) => element.classList.add('dark'));
  await expect(page.locator('.idpn-root.dark').first()).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

/**
 * The resolved stack is applied inside `.idpn-root` only, never on `:root`.
 *
 * This asserts the *declared* stack: the repository ships no webfont, so no browser can
 * actually rasterise Vazirmatn/Inter here and asserting `document.fonts.check` would fail
 * everywhere (card #56 finding 6). A real webfont is a separate, asset-bearing change.
 */
async function expectScopedFont(page: Page, family: 'Vazirmatn' | 'Inter'): Promise<void> {
  const rootFont = await page
    .getByTestId('idpn-root')
    .evaluate((element) => getComputedStyle(element).fontFamily);
  const documentFont = await page.evaluate(
    () => getComputedStyle(document.documentElement).fontFamily,
  );
  expect(rootFont).toContain(family);
  expect(documentFont).not.toContain(family);
  // The token the stack comes from is scoped to the same root.
  const token = await page
    .getByTestId('idpn-root')
    .evaluate((element) => getComputedStyle(element).getPropertyValue('--idpn-font-sans'));
  expect(token).toContain(family);
}

async function submitPasswordStep(page: Page, locale: 'fa-IR' | 'en-US'): Promise<void> {
  const identifier = locale === 'fa-IR' ? 'ایمیل یا نام کاربری' : 'Email or username';
  const password = locale === 'fa-IR' ? 'رمز عبور' : 'Password';
  const submit = locale === 'fa-IR' ? 'ورود' : 'Sign in';

  await page.getByLabel(identifier).fill('sara@example.com');
  await page.getByLabel(password).fill('a-very-long-password');
  await page.getByRole('button', { name: submit, exact: true }).click();
}

test.describe('hosted auth UI', () => {
  test('login in Persian RTL has no blocking violations', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(hosted('fa-IR'));

    await expect(page.getByTestId('idpn-root')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('idpn-root')).toHaveAttribute('lang', 'fa-IR');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fa-IR');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();
    await expectScopedFont(page, 'Vazirmatn');
    await expectNoHorizontalOverflow(page);
    await expectNoBlockingViolations(page);
  });

  test('login in English LTR has no blocking violations', async ({ page }) => {
    await installUiFixtures(page, { locale: 'en-US' });
    await page.goto(hosted('en-US'));

    await expect(page.getByTestId('idpn-root')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByTestId('idpn-root')).toHaveAttribute('lang', 'en-US');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expectScopedFont(page, 'Inter');
    await expectNoHorizontalOverflow(page);
    await expectNoBlockingViolations(page);
  });

  test('a per-client theme keeps WCAG AA contrast', async ({ page }) => {
    // A client theme reaches the page through the public config only (no code change).
    await installUiFixtures(page, {
      theme: { primary: '#0f766e', radius: '0rem', background: '#f8fafc', foreground: '#0f172a' },
    });
    await page.goto(hosted('fa-IR'));
    await expect(page.getByTestId('idpn-root')).toHaveCSS('--idpn-primary', '#0f766e');
    await expectNoBlockingViolations(page);
  });

  test('an inaccessible client theme falls back instead of rendering invisibly', async ({ page }) => {
    // White on white cannot reach 4.5:1: `sanitizeIdpnTheme` drops the pair, so the built-in
    // palette is painted and the surface still passes the axe colour-contrast rule.
    await installUiFixtures(page, {
      theme: { background: '#ffffff', foreground: '#ffffff' },
    });
    await page.goto(hosted('fa-IR'));

    const root = page.getByTestId('idpn-root');
    await expect(root).toHaveCSS('--idpn-foreground', 'oklch(0.145 0 0)');
    await expect(root).toHaveCSS('--idpn-background', 'oklch(1 0 0)');
    await expectNoBlockingViolations(page);
  });

  test('applies per-client translated overrides over the base bundle', async ({ page }) => {
    await installUiFixtures(page, {
      translations: {
        'login.title': 'ورود به پنل مشتریان',
        'login.submit': 'ورود به پنل',
      },
    });
    await page.goto(hosted('fa-IR'));

    await expect(page.getByTestId('idpn-root')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'ورود به پنل مشتریان' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ورود به پنل', exact: true })).toBeVisible();
    // A key omitted from the client bundle still comes from the shared base bundle.
    await expect(page.getByLabel('رمز عبور')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoBlockingViolations(page);
  });

  test('language switch keeps the authorize request and applies direction and font', async ({
    page,
  }) => {
    const remoteFonts: string[] = [];
    page.on('request', (request) => {
      if (/fonts\.(googleapis|gstatic)\.com/.test(request.url())) {
        remoteFonts.push(request.url());
      }
    });

    await installUiFixtures(page);
    await page.goto(hosted('fa-IR'));
    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();
    await page.getByLabel('ایمیل یا نام کاربری').fill('sara@example.com');

    await page.getByRole('combobox', { name: 'زبان' }).click();
    await page.getByRole('option', { name: 'English' }).click();

    const root = page.getByTestId('idpn-root');
    await expect(root).toHaveAttribute('lang', 'en-US');
    await expect(root).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expectScopedFont(page, 'Inter');
    // The in-progress form state survives the locale switch without a reload.
    await expect(page.getByLabel('Email or username')).toHaveValue('sara@example.com');

    const url = new URL(page.url());
    expect(url.searchParams.get('ui_locales')).toBe('en-US');
    expect(url.searchParams.get('return_to')).toBe('/oauth2/authorize?client_id=admin-panel');
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    expect(remoteFonts).toEqual([]);
    await expectNoHorizontalOverflow(page);
    await expectNoBlockingViolations(page);
  });

  test('login validation errors in dark theme have no blocking violations', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(hosted('fa-IR'));
    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();

    await useDarkTokens(page);
    await page.getByRole('button', { name: 'ورود', exact: true }).click();
    await expect(page.getByText('ایمیل یا نام کاربری را وارد کنید.')).toBeVisible();
    await expectNoBlockingViolations(page);
  });

  test('MFA step in Persian RTL has no blocking violations', async ({ page }) => {
    await installUiFixtures(page, { login: 'mfa' });
    await page.goto(hosted('fa-IR'));
    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();

    await submitPasswordStep(page, 'fa-IR');
    await expect(page.getByRole('heading', { name: 'ورود دومرحله‌ای' })).toBeVisible();
    await expect(page.getByTestId('idpn-root')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('idpn-root')).toHaveAttribute('lang', 'fa-IR');
    // Codes stay LTR inside the RTL layout so digits and dashes keep their order.
    await expect(page.getByLabel('کد ۶ رقمی')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByLabel('کد ۶ رقمی')).toBeFocused();
    await expectNoBlockingViolations(page);
  });

  test('MFA step in English LTR has no blocking violations', async ({ page }) => {
    await installUiFixtures(page, { login: 'mfa' });
    await page.goto(hosted('en-US'));
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await submitPasswordStep(page, 'en-US');
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    await expect(page.getByTestId('idpn-root')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByTestId('idpn-root')).toHaveAttribute('lang', 'en-US');
    await expect(page.getByLabel('6-digit code')).toHaveAttribute('dir', 'ltr');
    await expectNoBlockingViolations(page);
  });

  test('screen-reader smoke: one main landmark, one h1 and named controls', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(hosted('fa-IR'));
    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();

    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: 'ایمیل یا نام کاربری' })).toBeVisible();
    await expect(page.getByLabel('رمز عبور')).toBeVisible();
    await expect(page.getByRole('button', { name: 'ورود', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'رمز عبور را فراموش کرده‌اید؟' })).toBeVisible();

    // Error messages are announced: the field is described by the live error node.
    await page.getByRole('button', { name: 'ورود', exact: true }).click();
    const identifier = page.getByLabel('ایمیل یا نام کاربری');
    await expect(identifier).toHaveAttribute('aria-invalid', 'true');
    await expect(identifier).toHaveAttribute('aria-describedby', 'identifier-error');
    await expect(page.locator('#identifier-error')).toHaveAttribute('role', 'alert');
  });
});

test.describe('account micro-frontend', () => {
  for (const locale of ['fa-IR', 'en-US'] as const) {
    test(`renders the ${locale} account surface without blocking violations`, async ({ page }) => {
      await installUiFixtures(page, { locale });
      await page.goto(harness('account', locale));

      const module = page.getByTestId('account-module');
      await expect(module).toHaveAttribute('lang', locale);
      await expect(
        page.getByRole('heading', { name: locale === 'fa-IR' ? 'حساب کاربری' : 'Account' }),
      ).toBeVisible();
      await expect(page.getByText('negar@example.com')).toBeVisible();
      await expectNoBlockingViolations(page);
    });
  }

  test('account surface in dark theme has no blocking violations', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('account', 'fa-IR'));
    await expect(page.getByText('negar@example.com')).toBeVisible();

    await useDarkTokens(page);
    await expectNoBlockingViolations(page);
  });
});

test.describe('user-management micro-frontend', () => {
  for (const locale of ['fa-IR', 'en-US'] as const) {
    test(`renders the ${locale} member table without blocking violations`, async ({ page }) => {
      await installUiFixtures(page, { locale });
      await page.goto(harness('user-management', locale));

      await expect(page.getByTestId('idpn-root')).toHaveAttribute(
        'dir',
        locale === 'fa-IR' ? 'rtl' : 'ltr',
      );
      await expect(
        page.getByRole('heading', {
          name: locale === 'fa-IR' ? 'مدیریت کاربران' : 'Member management',
        }),
      ).toBeVisible();
      await expect(page.getByRole('table')).toBeVisible();
      await expect(page.getByText('Sara Ahmadi')).toBeVisible();
      await expectNoBlockingViolations(page);
    });
  }

  test('the status select in open state has no blocking violations', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('user-management', 'fa-IR'));
    await expect(page.getByText('Sara Ahmadi')).toBeVisible();

    const trigger = page.getByRole('combobox', { name: 'وضعیت عضویت' });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('listbox')).toBeVisible();
    await expectNoBlockingViolations(page);

    // Keyboard selection: the active option is reachable and committed with Enter.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(trigger).not.toContainText('همه وضعیت‌ها');
  });

  test('the invite dialog in open state has no blocking violations and traps focus', async ({
    page,
  }) => {
    await installUiFixtures(page);
    await page.goto(harness('user-management', 'fa-IR'));
    await expect(page.getByText('Sara Ahmadi')).toBeVisible();

    const invite = page.getByRole('button', { name: 'دعوت کاربر' });
    await invite.click();
    const dialog = page.getByRole('dialog', { name: 'دعوت عضو جدید' });
    await expect(dialog).toBeVisible();
    await expectNoBlockingViolations(page);

    // Focus stays inside the dialog for forward tabs (no keyboard escape).
    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(
        () => document.activeElement?.closest('[role="dialog"]') !== null,
      );
      expect(inside, `focus left the dialog after ${step + 1} Tab press(es)`).toBe(true);
    }

    // Escape closes the modal and restores focus to the trigger (docs/accessibility review).
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(invite).toBeFocused();
  });

  test('the roles dialog restores focus to the row action', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('user-management', 'fa-IR'));
    await expect(page.getByText('Sara Ahmadi')).toBeVisible();

    const roles = page.getByRole('button', { name: 'نقش‌ها' }).first();
    await roles.click();
    const dialog = page.getByRole('dialog', { name: 'نقش‌های نگار کریمی' });
    await expect(dialog).toBeVisible();
    await expectNoBlockingViolations(page);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(roles).toBeFocused();
  });

  test('user-management in dark theme has no blocking violations', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('user-management', 'fa-IR'));
    await expect(page.getByText('Sara Ahmadi')).toBeVisible();

    await useDarkTokens(page);
    await expectNoBlockingViolations(page);
  });
});

test.describe('admin console', () => {
  test('users tab in Persian RTL has no blocking violations', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('admin', 'fa-IR'));

    await expect(page.getByTestId('admin-row-ali')).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await expectNoBlockingViolations(page);
  });

  test('users tab in English LTR has no blocking violations', async ({ page }) => {
    await installUiFixtures(page, { locale: 'en-US' });
    await page.goto(harness('admin', 'en-US'));

    await expect(page.getByTestId('admin-row-ali')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Users' })).toBeVisible();
    await expectNoBlockingViolations(page);
  });

  test('sessions tab has no blocking violations and its status select works by keyboard', async ({
    page,
  }) => {
    await installUiFixtures(page);
    await page.goto(harness('admin', 'fa-IR'));
    await expect(page.getByTestId('admin-row-ali')).toBeVisible();

    await page.getByRole('tab', { name: 'نشست‌ها' }).click();
    await expect(page.getByTestId('session-row-session-1')).toBeVisible();
    await expectNoBlockingViolations(page);

    const trigger = page.getByRole('combobox', { name: 'وضعیت نشست' });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('listbox')).toBeVisible();
    await expectNoBlockingViolations(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toBeHidden();
  });

  test('audit tab has no blocking violations', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('admin', 'fa-IR'));
    await expect(page.getByTestId('admin-row-ali')).toBeVisible();

    await page.getByRole('tab', { name: 'ممیزی' }).click();
    await expect(page.getByTestId('admin-audit-row-evt-1')).toBeVisible();
    await expectNoBlockingViolations(page);
  });

  test('the create-user dialog in open state has no blocking violations and traps focus', async ({
    page,
  }) => {
    await installUiFixtures(page);
    await page.goto(harness('admin', 'fa-IR'));
    await expect(page.getByTestId('admin-row-ali')).toBeVisible();

    const create = page.getByRole('button', { name: 'کاربر جدید' });
    await create.click();
    const dialog = page.getByRole('dialog', { name: 'کاربر جدید' });
    await expect(dialog).toBeVisible();
    await expectNoBlockingViolations(page);

    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(
        () => document.activeElement?.closest('[role="dialog"]') !== null,
      );
      expect(inside, `focus left the dialog after ${step + 1} Tab press(es)`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(create).toBeFocused();
  });

  test('admin console in dark theme has no blocking violations', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('admin', 'fa-IR'));
    await expect(page.getByTestId('admin-row-ali')).toBeVisible();

    await useDarkTokens(page);
    await expectNoBlockingViolations(page);
  });
});
