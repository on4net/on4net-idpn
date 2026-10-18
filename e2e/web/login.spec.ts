import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('hosted login (spike)', () => {
  test('renders an RTL Persian form without critical accessibility violations', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.getByTestId('idpn-root')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();
    await expect(page.getByLabel('ایمیل')).toBeVisible();
    await expect(page.getByLabel('رمز عبور')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations
      .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
      .map((violation) => `${violation.id}: ${violation.help}`);

    expect(blocking).toEqual([]);
  });

  test('validates a keyboard-submitted form and exposes errors to assistive tech', async ({
    page,
  }) => {
    await page.goto('/');

    await page.getByLabel('ایمیل').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');

    await expect(page.getByText('ایمیل یا نام کاربری را وارد کنید')).toBeVisible();
    await expect(page.getByLabel('ایمیل')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('ایمیل')).toHaveAttribute('aria-describedby', 'identifier-error');
  });

  test('keeps dialog focus and portals inside the MFE root', async ({ page }) => {
    await page.goto('/');
    const trigger = page.getByRole('button', { name: 'رمز عبور را فراموش کرده‌اید؟' });

    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'بازیابی رمز عبور' });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('idpn-portal-root').getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('renders the select popup in the portal root', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('combobox', { name: 'نوع ورود' }).click();
    const option = page.getByRole('option', { name: 'تیم مشتری' });
    await expect(option).toBeVisible();

    await option.click();
    await expect(page.getByRole('combobox', { name: 'نوع ورود' })).toContainText('تیم مشتری');
  });
});
