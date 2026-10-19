import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Direction parity for the two public surfaces: the Hosted login page (regular DOM) and the
 * federated/Web Component modules (Shadow DOM). The assertions are structural - direction
 * attributes, logical alignment of labels against their controls, portal containment and
 * absence of horizontal overflow - so they do not depend on pixel baselines.
 */

const hostedPath = (locale: 'fa-IR' | 'en-US'): string =>
  `/?client_id=admin-panel&ui_locales=${locale}&return_to=%2Foauth2%2Fauthorize%3Fclient_id%3Dadmin-panel`;

const member = {
  membershipId: 'm1',
  userId: 'u1',
  email: 'negar@example.com',
  username: 'negar',
  displayName: 'نگار کریمی',
  userStatus: 'active',
  status: 'active',
  attributes: {},
  roleKeys: ['app-a:member'],
  invitedAt: null,
  joinedAt: '2026-10-19T09:00:00.000Z',
  createdAt: '2026-10-19T09:00:00.000Z',
  updatedAt: '2026-10-19T09:00:00.000Z',
};

/** Deterministic API fixture: the host page and the extra LTR element share the routes. */
async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/v1/clients/app-a/members**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [member], page: 1, limit: 10, total: 1 }),
    }),
  );
  await page.route('**/api/v1/roles**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          { id: 'r1', key: 'app-a:member', name: 'عضو', description: 'member', isDefault: true },
        ],
      }),
    }),
  );
  await page.route('**/api/v1/account/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'u1',
        username: 'negar',
        email: 'negar@example.com',
        displayName: 'نگار کریمی',
        phone: null,
        avatarUrl: null,
        locale: 'fa-IR',
        status: 'active',
        emailVerified: true,
        mustChangePassword: false,
        createdAt: '2026-10-19T09:00:00.000Z',
        passwordChangedAt: null,
      }),
    }),
  );
  await page.route('**/api/v1/account/sessions**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], page: 1, limit: 25, total: 0 }),
    }),
  );
  await page.route('**/api/v1/account/mfa', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: false, factors: [] }),
    }),
  );
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

/** Inline box of the element's text run, not its full-width block box. */
async function textBox(locator: Locator): Promise<{ left: number; right: number }> {
  return locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  });
}

async function box(locator: Locator): Promise<{ left: number; right: number; top: number }> {
  const rect = await locator.boundingBox();
  if (rect === null) {
    throw new Error('Element has no bounding box');
  }
  return { left: rect.x, right: rect.x + rect.width, top: rect.y };
}

test.describe('hosted login direction parity', () => {
  test('fa-IR renders RTL with start-aligned labels and no overflow', async ({ page }) => {
    await page.goto(hostedPath('fa-IR'));

    const root = page.getByTestId('idpn-root');
    await expect(root).toHaveAttribute('dir', 'rtl');
    await expect(root).toHaveAttribute('lang', 'fa-IR');
    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();

    const identifier = page.getByLabel('ایمیل یا نام کاربری');
    const label = page.locator('label[for="identifier"]');
    await expect(identifier).toBeVisible();
    await expect(identifier).toHaveAttribute('dir', 'auto');

    // RTL: label and control share the inline start (right edge).
    const labelBox = await textBox(label);
    const controlBox = await box(identifier);
    expect(Math.abs(labelBox.right - controlBox.right)).toBeLessThanOrEqual(2);

    const card = await box(page.getByRole('main'));
    const submit = await box(page.getByRole('button', { name: 'ورود' }));
    expect(submit.left).toBeGreaterThanOrEqual(card.left);
    expect(submit.right).toBeLessThanOrEqual(card.right);

    await expectNoHorizontalOverflow(page);
  });

  test('en-US renders LTR with the same structure and no overflow', async ({ page }) => {
    await page.goto(hostedPath('en-US'));

    const root = page.getByTestId('idpn-root');
    await expect(root).toHaveAttribute('dir', 'ltr');
    await expect(root).toHaveAttribute('lang', 'en-US');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    const identifier = page.getByLabel('Email or username');
    const label = page.locator('label[for="identifier"]');
    await expect(identifier).toBeVisible();

    const labelBox = await textBox(label);
    const controlBox = await box(identifier);
    expect(Math.abs(labelBox.left - controlBox.left)).toBeLessThanOrEqual(2);

    const card = await box(page.getByRole('main'));
    const submit = await box(page.getByRole('button', { name: 'Sign in' }));
    expect(submit.left).toBeGreaterThanOrEqual(card.left);
    expect(submit.right).toBeLessThanOrEqual(card.right);

    await expectNoHorizontalOverflow(page);
  });
});

test.describe('MFE direction parity', () => {
  test('fa-IR renders the federated module RTL and keeps portals inside its root', async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto('/host/');

    const hostElement = page.locator('#mfe on4net-idpn-user-management');
    const root = hostElement.locator('.idpn-root');
    await expect(root).toBeVisible();
    await expect(root).toHaveAttribute('dir', 'rtl');

    const heading = hostElement.locator('h2', { hasText: 'مدیریت کاربران' }).first();
    const client = hostElement.locator('p', { hasText: 'app-a' }).first();
    const headingBox = await textBox(heading);
    const clientBox = await textBox(client);
    expect(Math.abs(headingBox.right - clientBox.right)).toBeLessThanOrEqual(2);

    await hostElement.getByRole('button', { name: 'دعوت کاربر' }).click();
    const dialog = hostElement.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();

    const dialogInsideRoot = await hostElement.evaluate((element) => {
      const rootNode = element.shadowRoot?.querySelector('.idpn-root') ?? null;
      const dialogNode = element.shadowRoot?.querySelector('[role="dialog"]') ?? null;
      return rootNode !== null && dialogNode !== null && rootNode.contains(dialogNode);
    });
    expect(dialogInsideRoot).toBe(true);

    const inviteEmail = dialog.locator('input[type="email"]');
    await expect(inviteEmail).toHaveAttribute('dir', 'ltr');
    const dialogBox = await box(dialog);
    const emailBox = await box(inviteEmail);
    expect(emailBox.left).toBeGreaterThanOrEqual(dialogBox.left);
    expect(emailBox.right).toBeLessThanOrEqual(dialogBox.right);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await hostElement.getByRole('combobox', { name: 'وضعیت عضویت' }).click();
    const listbox = hostElement.locator('[role="listbox"]');
    await expect(listbox).toBeVisible();
    await expect(listbox).toHaveAttribute('dir', 'rtl');

    const selectInsideRoot = await hostElement.evaluate((element) => {
      const rootNode = element.shadowRoot?.querySelector('.idpn-root') ?? null;
      const listboxNode = element.shadowRoot?.querySelector('[role="listbox"]') ?? null;
      return rootNode !== null && listboxNode !== null && rootNode.contains(listboxNode);
    });
    expect(selectInsideRoot).toBe(true);

    await expectNoHorizontalOverflow(page);
  });

  test('en-US renders the same module LTR with scoped identifiers and contained portals', async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto('/host/');
    await expect(page.locator('#mfe .idpn-root')).toBeVisible();

    // The host fixture is pinned to fa-IR; mount a second instance with the host contract
    // for the other locale instead of overriding build-time configuration.
    await page.evaluate(() => {
      const element = document.createElement('on4net-idpn-user-management');
      element.setAttribute('locale', 'en-US');
      element.setAttribute('dir', 'ltr');
      element.setAttribute('client-id', 'app-a');
      element.setAttribute('data-testid', 'ltr-module');
      document.body.append(element);
    });

    const hostElement = page.getByTestId('ltr-module');
    const root = hostElement.locator('.idpn-root');
    await expect(root).toBeVisible();
    await expect(root).toHaveAttribute('dir', 'ltr');
    await expect(root).toHaveAttribute('lang', 'en-US');

    const heading = hostElement.locator('h2', { hasText: 'مدیریت کاربران' }).first();
    const client = hostElement.locator('p', { hasText: 'app-a' }).first();
    const headingBox = await textBox(heading);
    const clientBox = await textBox(client);
    expect(Math.abs(headingBox.left - clientBox.left)).toBeLessThanOrEqual(2);

    const emailCell = hostElement.locator('td bdi[dir="ltr"]').first();
    await expect(emailCell).toHaveText('negar@example.com');

    await hostElement.getByRole('button', { name: 'دعوت کاربر' }).click();
    const dialog = hostElement.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();

    const dialogDirection = await hostElement.evaluate((element) => {
      const dialogNode = element.shadowRoot?.querySelector('[role="dialog"]');
      return dialogNode?.closest('[dir]')?.getAttribute('dir') ?? null;
    });
    expect(dialogDirection).toBe('ltr');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await hostElement.getByRole('combobox', { name: 'وضعیت عضویت' }).click();
    const listbox = hostElement.locator('[role="listbox"]');
    await expect(listbox).toHaveAttribute('dir', 'ltr');

    const listboxInsideRoot = await hostElement.evaluate((element) => {
      const rootNode = element.shadowRoot?.querySelector('.idpn-root') ?? null;
      const listboxNode = element.shadowRoot?.querySelector('[role="listbox"]') ?? null;
      return rootNode !== null && listboxNode !== null && rootNode.contains(listboxNode);
    });
    expect(listboxInsideRoot).toBe(true);

    await expectNoHorizontalOverflow(page);
  });
});
