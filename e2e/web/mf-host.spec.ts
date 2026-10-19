import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const members = [
  {
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
  },
];

/**
 * The host fixture has no API server. Deterministic member/role responses let the tests
 * exercise the federated module instead of its error state.
 */
async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/v1/clients/app-a/members**', (route) => {
    if (route.request().method() === 'POST') {
      const invited = {
        ...members[0]!,
        membershipId: 'm2',
        userId: 'u2',
        email: 'nima@example.com',
        username: 'nima',
        displayName: 'نیما کریمی',
        joinedAt: null,
        invitedAt: '2026-10-19T10:00:00.000Z',
      };
      members.push(invited);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ member: invited, createdUser: false }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: members, page: 1, limit: 10, total: members.length }),
    });
  });
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
}

test.describe('module federation host (spike)', () => {
  test('mounts the remote module with shared React and keeps host styles intact', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    await mockApi(page);

    await page.goto('/');

    // Remote mounted inside the host and rendered with hooks (proves a single React instance).
    const mfeRoot = page.locator('#host-root .idpn-root');
    await expect(mfeRoot).toBeVisible();
    await expect(mfeRoot).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'مدیریت کاربران' })).toBeVisible();
    await expect(page.getByText('نگار کریمی')).toBeVisible();

    // The account remote is mounted too, with its own root and safe states.
    await expect(page.locator('#account-root .idpn-root')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'حساب کاربری' })).toBeVisible();

    // Host styles survive the remote CSS.
    await expect(page.locator('#host-title')).toHaveCSS('font-size', '40px');
    await expect(page.locator('#host-button')).toHaveCSS('background-color', 'rgb(200, 0, 0)');
    await expect(page.locator('#host-button')).toHaveCSS('font-size', '24px');
    await expect(page.locator('#host-paragraph')).toHaveCSS('display', 'block');

    // Interaction works across the federation boundary.
    await page.getByRole('button', { name: 'دعوت کاربر' }).click();
    const dialog = page.getByRole('dialog', { name: 'دعوت عضو جدید' });
    await expect(dialog).toBeVisible();
    await page.getByLabel('ایمیل').fill('nima@example.com');
    await page.getByLabel('نام نمایشی (اختیاری)').fill('نیما کریمی');
    await page.getByRole('button', { name: 'دعوت', exact: true }).click();
    await expect(page.getByRole('table', { name: 'اعضای اپ app-a' })).toContainText('نیما کریمی');

    expect(consoleErrors).toEqual([]);
  });

  test('portals stay inside the MFE root and axe reports no blocking issues', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'مدیریت کاربران' })).toBeVisible();

    await page.getByRole('button', { name: 'دعوت کاربر' }).click();
    await expect(page.getByRole('dialog', { name: 'دعوت عضو جدید' })).toBeVisible();

    const dialogLocation = await page.evaluate(() => ({
      insideMfeRoot: document.querySelector('#host-root .idpn-root [role="dialog"]') !== null,
      inDocumentBody: document.body.querySelector(':scope > [role="dialog"]') !== null,
    }));
    expect(dialogLocation.insideMfeRoot).toBe(true);
    expect(dialogLocation.inDocumentBody).toBe(false);

    await page.keyboard.press('Escape');

    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations
      .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
      .map((violation) => `${violation.id}: ${violation.help}`);

    expect(blocking).toEqual([]);
  });
});
