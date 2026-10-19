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
      const root = host?.shadowRoot?.querySelector('.idpn-root') ?? null;
      const dialog = host?.shadowRoot?.querySelector('[role="dialog"]') ?? null;
      const portalRoot = dialog?.closest('[data-idpn-portal-root]') ?? null;
      return {
        insideShadowRoot: dialog !== null,
        insideIdpnRoot: root !== null && dialog !== null && root.contains(dialog),
        insidePortalRoot: portalRoot !== null,
        inDocumentBody: document.body.querySelector('[role="dialog"]') !== null,
      };
    });
    expect(dialogLocation).toEqual({
      insideShadowRoot: true,
      insideIdpnRoot: true,
      insidePortalRoot: true,
      inDocumentBody: false,
    });

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'دعوت عضو جدید' })).toBeHidden();

    // Select is portalled through the same shadow-root host, not the document body.
    await page.getByRole('combobox', { name: 'وضعیت عضویت' }).click();
    await expect(page.getByRole('listbox')).toBeVisible();
    const selectLocation = await page.evaluate(() => {
      const host = document.querySelector('#mfe on4net-idpn-user-management');
      const root = host?.shadowRoot?.querySelector('.idpn-root') ?? null;
      const listbox = host?.shadowRoot?.querySelector('[role="listbox"]') ?? null;
      return {
        insideIdpnRoot: root !== null && listbox !== null && root.contains(listbox),
        insidePortalRoot: listbox?.closest('[data-idpn-portal-root]') !== null,
        inDocumentBody: document.body.querySelector('[role="listbox"]') !== null,
      };
    });
    expect(selectLocation).toEqual({
      insideIdpnRoot: true,
      insidePortalRoot: true,
      inDocumentBody: false,
    });
  });

  test('publishes no theme or Tailwind variables on the document root', async ({ page }) => {
    await mockApi(page);
    await page.goto('/host/');
    await expect(page.locator('#mfe .idpn-root')).toBeVisible();

    const rootVariables = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return [
        '--idpn-primary',
        '--primary',
        '--background',
        '--radius',
        '--spacing',
        '--font-mono',
        '--color-black',
        '--animate-spin',
      ].map((name) => [name, style.getPropertyValue(name).trim()]);
    });

    expect(rootVariables).toEqual([
      ['--idpn-primary', ''],
      ['--primary', ''],
      ['--background', ''],
      ['--radius', ''],
      ['--spacing', ''],
      ['--font-mono', ''],
      ['--color-black', ''],
      ['--animate-spin', ''],
    ]);
  });

  test('keeps inherited host tokens out of the MFE and two instances independent', async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto('/host/');
    await expect(page.locator('#mfe .idpn-root')).toBeVisible();

    // A hostile host variable with the same name as a theme token must not win: the
    // module declares its own defaults on `.idpn-root`, not as an inherited fallback.
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--idpn-primary', 'rgb(255, 0, 0)');
    });

    const defaultInvite = page.locator('#mfe').getByRole('button', { name: 'دعوت کاربر' });
    await expect(defaultInvite).toBeVisible();
    const defaultBackground = await defaultInvite.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(defaultBackground).not.toBe('rgb(255, 0, 0)');

    // Two instances of the same module on one page with different client themes.
    await page.evaluate(() => {
      const first = document.querySelector('#mfe on4net-idpn-user-management');
      if (!(first instanceof HTMLElement)) {
        throw new Error('first module missing');
      }
      Reflect.set(first, 'theme', { primary: '#0000ff' });

      const second = document.createElement('on4net-idpn-user-management');
      second.id = 'second-mfe';
      second.setAttribute('client-id', 'app-a');
      second.setAttribute('locale', 'fa-IR');
      second.setAttribute('dir', 'rtl');
      Reflect.set(second, 'theme', { primary: '#ff0000' });
      document.body.append(second);
    });

    const firstInvite = page.locator('#mfe').getByRole('button', { name: 'دعوت کاربر' });
    const secondInvite = page.locator('#second-mfe').getByRole('button', { name: 'دعوت کاربر' });
    await expect(secondInvite).toBeVisible();

    await expect(firstInvite).toHaveCSS('background-color', 'rgb(0, 0, 255)');
    await expect(secondInvite).toHaveCSS('background-color', 'rgb(255, 0, 0)');

    const tokens = await page.evaluate(() =>
      ['#mfe', '#second-mfe'].map((selector) => {
        const slot = document.querySelector(selector);
        const host = slot?.shadowRoot ? slot : slot?.querySelector('on4net-idpn-user-management');
        const root = host?.shadowRoot?.querySelector('.idpn-root') ?? null;
        const portal = root?.querySelector('[data-testid="idpn-portal-root"]');
        return {
          primary: root === null ? null : getComputedStyle(root).getPropertyValue('--idpn-primary'),
          hasPortal: portal !== null && portal !== undefined,
        };
      }),
    );
    expect(tokens).toEqual([
      { primary: '#0000ff', hasPortal: true },
      { primary: '#ff0000', hasPortal: true },
    ]);
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
