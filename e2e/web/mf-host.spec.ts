import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

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

    await page.goto('/');

    // Remote mounted inside the host and rendered with hooks (proves a single React instance).
    const mfeRoot = page.locator('#host-root .idpn-root');
    await expect(mfeRoot).toBeVisible();
    await expect(mfeRoot).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'مدیریت کاربران' })).toBeVisible();

    // Host styles survive the remote CSS.
    await expect(page.locator('#host-title')).toHaveCSS('font-size', '40px');
    await expect(page.locator('#host-button')).toHaveCSS('background-color', 'rgb(200, 0, 0)');
    await expect(page.locator('#host-button')).toHaveCSS('font-size', '24px');
    await expect(page.locator('#host-paragraph')).toHaveCSS('display', 'block');

    // Interaction works across the federation boundary.
    await page.getByRole('button', { name: 'افزودن کاربر' }).click();
    const dialog = page.getByRole('dialog', { name: 'کاربر جدید' });
    await expect(dialog).toBeVisible();
    await page.getByLabel('نام').fill('نگار کریمی');
    await page.getByLabel('ایمیل').fill('negar@example.com');
    await page.getByRole('button', { name: 'ذخیره' }).click();
    await expect(page.getByRole('list', { name: 'فهرست کاربران' })).toContainText('نگار کریمی');

    expect(consoleErrors).toEqual([]);
  });

  test('portals stay inside the MFE root and axe reports no blocking issues', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'مدیریت کاربران' })).toBeVisible();

    await page.getByRole('button', { name: 'افزودن کاربر' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

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
