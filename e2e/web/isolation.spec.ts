import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

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

/** The fixture has no API; deterministic responses keep the isolation assertions focused. */
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
  // The fixture mounts the account module next to user-management; keep both deterministic.
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

test.describe('web component isolation (spike)', () => {
  test('does not leak MFE styles into the host and keeps portals inside the shadow root', async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto('/host/');
    await expect(page.locator('#host-title')).toBeVisible();

    // Host styles survive: no global reset/preflight and no utility override.
    await expect(page.locator('#host-title')).toHaveCSS('font-size', '40px');
    await expect(page.locator('#host-button')).toHaveCSS('background-color', 'rgb(200, 0, 0)');
    await expect(page.locator('#host-button')).toHaveCSS('font-size', '24px');
    await expect(page.locator('#host-button')).toHaveCSS('display', 'block');
    await expect(page.locator('#host-button')).toHaveCSS('padding', '1px');
    await expect(page.locator('body')).toHaveCSS('font-family', /Georgia/);

    // MFE renders inside the shadow root with its own direction and tokens.
    const mfeRoot = page.locator('#mfe .idpn-root');
    await expect(mfeRoot).toBeVisible();
    await expect(mfeRoot).toHaveAttribute('dir', 'rtl');

    const invite = page.getByRole('button', { name: 'دعوت کاربر' });
    await expect(invite).toBeVisible();
    // Scope to the user-management module: the account fixture renders the same person.
    await expect(page.locator('#mfe').getByText('نگار کریمی')).toBeVisible();

    const mfeButtonBackground = await invite.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(mfeButtonBackground).not.toBe('rgb(200, 0, 0)');

    // Radix portals must render inside the shadow root, not in document.body.
    await invite.click();
    await expect(page.getByRole('dialog', { name: 'دعوت عضو جدید' })).toBeVisible();

    const dialogLocation = await page.evaluate(() => {
      // `#mfe` is the host slot; the custom element owns the shadow root.
      const host = document.querySelector('#mfe on4net-idpn-user-management');
      const dialog = host?.shadowRoot?.querySelector('[role="dialog"]');
      return {
        insideShadowRoot: dialog !== null && dialog !== undefined,
        inDocumentBody: document.body.querySelector('[role="dialog"]') !== null,
      };
    });
    expect(dialogLocation.insideShadowRoot).toBe(true);
    expect(dialogLocation.inDocumentBody).toBe(false);
  });

  test('host page has no critical accessibility violations', async ({ page }) => {
    await mockApi(page);
    await page.goto('/host/');
    await expect(page.locator('#host-title')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations
      .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
      .map((violation) => `${violation.id}: ${violation.help}`);

    expect(blocking).toEqual([]);
  });
});
