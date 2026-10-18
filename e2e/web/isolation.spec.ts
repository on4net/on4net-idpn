import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('web component isolation (spike)', () => {
  test('does not leak MFE styles into the host and keeps portals inside the shadow root', async ({
    page,
  }) => {
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

    const addUser = page.getByRole('button', { name: 'افزودن کاربر' });
    await expect(addUser).toBeVisible();

    const mfeButtonBackground = await addUser.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(mfeButtonBackground).not.toBe('rgb(200, 0, 0)');

    // Radix portals must render inside the shadow root, not in document.body.
    await addUser.click();
    await expect(page.getByRole('dialog', { name: 'کاربر جدید' })).toBeVisible();

    const dialogLocation = await page.evaluate(() => {
      const host = document.querySelector('#mfe');
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
    await page.goto('/host/');
    await expect(page.locator('#host-title')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations
      .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
      .map((violation) => `${violation.id}: ${violation.help}`);

    expect(blocking).toEqual([]);
  });
});
