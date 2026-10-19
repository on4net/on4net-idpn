import { expect, test, type Locator, type Page } from '@playwright/test';

import { installUiFixtures } from '../support/ui-fixtures';

/**
 * Visual regression baselines for the shared shadcn/ui surfaces.
 *
 * Determinism: fixed viewport/deviceScaleFactor from `playwright.ui.config.ts`, UTC,
 * system font stack only (no remote font requests), fixture data with fixed timestamps,
 * animations and caret disabled per screenshot.
 *
 * Update procedure (only after an intentional UI change, reviewed in the PR):
 *   pnpm test:visual:update
 * Baselines are stored per platform under `e2e/visual/__screenshots__/<platform>/` because
 * font rasterisation differs between operating systems.
 */

const LOGIN_PATH =
  '/?client_id=admin-panel&return_to=%2Foauth2%2Fauthorize%3Fclient_id%3Dadmin-panel';

const hosted = (locale: 'fa-IR' | 'en-US'): string =>
  `${LOGIN_PATH}&ui_locales=${encodeURIComponent(locale)}`;

const harness = (
  surface: 'account' | 'user-management' | 'admin',
  locale: 'fa-IR' | 'en-US',
): string => `/harness/?surface=${surface}&locale=${encodeURIComponent(locale)}`;

const SCREENSHOT = { animations: 'disabled', caret: 'hide' } as const;

/** Stable content waits: the assertion doubles as the readiness signal for the shot. */
async function waitForLogin(page: Page, locale: 'fa-IR' | 'en-US'): Promise<Locator> {
  const heading = locale === 'fa-IR' ? 'ورود به حساب' : 'Sign in';
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return page.locator('main').first();
}

async function waitForMfa(page: Page, locale: 'fa-IR' | 'en-US'): Promise<Locator> {
  const heading = locale === 'fa-IR' ? 'ورود دومرحله‌ای' : 'Two-step verification';
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return page.locator('main').first();
}

async function waitForAccount(page: Page): Promise<Locator> {
  const module = page.getByTestId('account-module');
  await expect(page.getByText('negar@example.com')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return module;
}

async function waitForMembers(page: Page): Promise<Locator> {
  await expect(page.getByText('Sara Ahmadi')).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return page.locator('section').first();
}

async function waitForAdmin(page: Page): Promise<Locator> {
  await expect(page.getByTestId('admin-row-ali')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return page.getByTestId('admin-console');
}

async function setDark(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '*,*::before,*::after{transition:none!important;animation:none!important}',
  });
  await page
    .locator('.idpn-root')
    .first()
    .evaluate((element) => element.classList.add('dark'));
  await expect(page.locator('.idpn-root.dark').first()).toBeVisible();
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
  test('login — fa-IR RTL / light', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(hosted('fa-IR'));
    const card = await waitForLogin(page, 'fa-IR');
    await expect(card).toHaveScreenshot('login-fa-light.png', SCREENSHOT);
  });

  test('login — en-US LTR / light', async ({ page }) => {
    await installUiFixtures(page, { locale: 'en-US' });
    await page.goto(hosted('en-US'));
    const card = await waitForLogin(page, 'en-US');
    await expect(card).toHaveScreenshot('login-en-light.png', SCREENSHOT);
  });

  test('login — fa-IR RTL / dark', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(hosted('fa-IR'));
    const card = await waitForLogin(page, 'fa-IR');
    await setDark(page);
    await expect(card).toHaveScreenshot('login-fa-dark.png', SCREENSHOT);
  });

  test('MFA — fa-IR RTL / light', async ({ page }) => {
    await installUiFixtures(page, { login: 'mfa' });
    await page.goto(hosted('fa-IR'));
    await waitForLogin(page, 'fa-IR');
    await submitPasswordStep(page, 'fa-IR');
    const card = await waitForMfa(page, 'fa-IR');
    await expect(card).toHaveScreenshot('mfa-fa-light.png', SCREENSHOT);
  });

  test('MFA — en-US LTR / light', async ({ page }) => {
    await installUiFixtures(page, { login: 'mfa', locale: 'en-US' });
    await page.goto(hosted('en-US'));
    await waitForLogin(page, 'en-US');
    await submitPasswordStep(page, 'en-US');
    const card = await waitForMfa(page, 'en-US');
    await expect(card).toHaveScreenshot('mfa-en-light.png', SCREENSHOT);
  });
});

test.describe('account micro-frontend', () => {
  test('account — fa-IR RTL / light', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('account', 'fa-IR'));
    const module = await waitForAccount(page);
    await expect(module).toHaveScreenshot('account-fa-light.png', SCREENSHOT);
  });

  test('account — en-US LTR / light', async ({ page }) => {
    await installUiFixtures(page, { locale: 'en-US' });
    await page.goto(harness('account', 'en-US'));
    const module = await waitForAccount(page);
    await expect(module).toHaveScreenshot('account-en-light.png', SCREENSHOT);
  });

  test('account — fa-IR RTL / dark', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('account', 'fa-IR'));
    const module = await waitForAccount(page);
    await setDark(page);
    await expect(module).toHaveScreenshot('account-fa-dark.png', SCREENSHOT);
  });
});

test.describe('user-management micro-frontend', () => {
  test('member table — fa-IR RTL / light', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('user-management', 'fa-IR'));
    const module = await waitForMembers(page);
    await expect(module).toHaveScreenshot('user-management-fa-light.png', SCREENSHOT);
  });

  test('member table — en-US LTR / light', async ({ page }) => {
    await installUiFixtures(page, { locale: 'en-US' });
    await page.goto(harness('user-management', 'en-US'));
    const module = await waitForMembers(page);
    await expect(module).toHaveScreenshot('user-management-en-light.png', SCREENSHOT);
  });

  test('member table — fa-IR RTL / dark', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('user-management', 'fa-IR'));
    const module = await waitForMembers(page);
    await setDark(page);
    await expect(module).toHaveScreenshot('user-management-fa-dark.png', SCREENSHOT);
  });

  test('table component — fa-IR RTL', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('user-management', 'fa-IR'));
    await waitForMembers(page);
    await expect(page.getByRole('table')).toHaveScreenshot('table-fa.png', SCREENSHOT);
  });

  test('status select — fa-IR RTL / open', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('user-management', 'fa-IR'));
    await waitForMembers(page);

    const trigger = page.getByRole('combobox', { name: 'وضعیت عضویت' });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();

    const triggerBox = await trigger.boundingBox();
    const listboxBox = await listbox.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(listboxBox).not.toBeNull();
    if (triggerBox === null || listboxBox === null) {
      return;
    }
    const x = Math.min(triggerBox.x, listboxBox.x) - 8;
    const y = Math.min(triggerBox.y, listboxBox.y) - 8;
    const right = Math.max(triggerBox.x + triggerBox.width, listboxBox.x + listboxBox.width) + 8;
    const bottom = Math.max(triggerBox.y + triggerBox.height, listboxBox.y + listboxBox.height) + 8;
    await expect(page).toHaveScreenshot('select-open-fa.png', {
      ...SCREENSHOT,
      clip: { x, y, width: right - x, height: bottom - y },
    });
  });

  test('invite dialog — fa-IR RTL / open', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('user-management', 'fa-IR'));
    await waitForMembers(page);

    await page.getByRole('button', { name: 'دعوت کاربر' }).click();
    const dialog = page.getByRole('dialog', { name: 'دعوت عضو جدید' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveScreenshot('dialog-invite-fa.png', SCREENSHOT);
  });
});

test.describe('admin console', () => {
  test('users tab — fa-IR RTL / light', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('admin', 'fa-IR'));
    const console = await waitForAdmin(page);
    await expect(console).toHaveScreenshot('admin-users-fa-light.png', SCREENSHOT);
  });

  test('users tab — en-US LTR / light', async ({ page }) => {
    await installUiFixtures(page, { locale: 'en-US' });
    await page.goto(harness('admin', 'en-US'));
    const console = await waitForAdmin(page);
    await expect(console).toHaveScreenshot('admin-users-en-light.png', SCREENSHOT);
  });

  test('users tab — fa-IR RTL / dark', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('admin', 'fa-IR'));
    const console = await waitForAdmin(page);
    await setDark(page);
    await expect(console).toHaveScreenshot('admin-users-fa-dark.png', SCREENSHOT);
  });

  test('sessions tab — fa-IR RTL / light', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('admin', 'fa-IR'));
    const console = await waitForAdmin(page);

    await page.getByRole('tab', { name: 'نشست‌ها' }).click();
    await expect(page.getByTestId('session-row-session-1')).toBeVisible();
    await expect(console).toHaveScreenshot('admin-sessions-fa-light.png', SCREENSHOT);
  });

  test('audit tab — fa-IR RTL / light', async ({ page }) => {
    await installUiFixtures(page);
    await page.goto(harness('admin', 'fa-IR'));
    const console = await waitForAdmin(page);

    await page.getByRole('tab', { name: 'ممیزی' }).click();
    await expect(page.getByTestId('admin-audit-row-evt-1')).toBeVisible();
    await expect(console).toHaveScreenshot('admin-audit-fa-light.png', SCREENSHOT);
  });
});
