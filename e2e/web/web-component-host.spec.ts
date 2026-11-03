import { expect, test, type Page } from '@playwright/test';

const CLIENT_ID = 'app-a';
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://127.0.0.1:5180';
const HOSTED_LOGIN_URL = `${WEB_URL}/oauth2/authorize`;

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

interface MockApiOptions {
  /** Return a Problem Details response for the member list (used to emit auth:error). */
  membersStatus?: number;
}

/**
 * The vanilla host has no API server. Deterministic responses keep the assertions focused
 * on mounting, isolation and the event contract instead of transport noise.
 */
async function mockApi(page: Page, options: MockApiOptions = {}): Promise<void> {
  await page.route(`**/api/v1/clients/${CLIENT_ID}/members**`, (route) => {
    if (options.membersStatus !== undefined) {
      return route.fulfill({
        status: options.membersStatus,
        contentType: 'application/problem+json',
        body: JSON.stringify({ title: 'Forbidden', status: options.membersStatus }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [member], page: 1, limit: 10, total: 1 }),
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
  await page.route('**/api/v1/account/mfa', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: false, factors: [] }),
    }),
  );
}

test.describe('vanilla host + Web Component', () => {
  test('mounts user-management and account for the configured client without tokens', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const apiRequests: string[] = [];
    const authorizationHeaders: string[] = [];

    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/api/v1/')) {
        apiRequests.push(url);
        const authorization = request.headers()['authorization'];
        if (authorization !== undefined) {
          authorizationHeaders.push(authorization);
        }
      }
    });
    await mockApi(page);

    // Hostile query string: the host must use build-time configuration only.
    await page.goto('/host/?clientId=attacker&mode=spa&module=account');

    const userManagement = page.getByTestId('host-slot-user-management');
    const account = page.getByTestId('host-slot-account');
    await expect(userManagement.locator('.idpn-root')).toBeVisible();
    await expect(account.locator('.idpn-root')).toBeVisible();

    await expect(page.getByRole('heading', { name: 'مدیریت کاربران' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'حساب کاربری' })).toBeVisible();
    await expect(userManagement.getByText('نگار کریمی')).toBeVisible();

    // The host reports the configuration it actually used.
    await expect(page.getByTestId('host-client-id')).toHaveText(CLIENT_ID);
    await expect(page.getByTestId('host-mode')).toHaveText('bff');
    await expect(page.getByTestId('host-locale')).toHaveText('fa-IR (rtl)');

    // Module API calls stay scoped to the configured client and never carry a token.
    const memberUrls = apiRequests.filter((url) => url.includes('/members'));
    expect(memberUrls.length).toBeGreaterThan(0);
    for (const url of memberUrls) {
      expect(new URL(url).pathname).toBe(`/api/v1/clients/${CLIENT_ID}/members`);
    }
    expect(apiRequests.some((url) => url.includes('attacker'))).toBe(false);
    expect(authorizationHeaders).toEqual([]);

    // BFF mode: no token material in storage, cookies or the elements themselves.
    const surface = await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookies: document.cookie,
      attributes: Array.from(document.querySelectorAll('[data-idpn-mfe]')).map((element) =>
        Array.from(element.attributes)
          .map((attribute) => attribute.name)
          .sort(),
      ),
      html: document.documentElement.outerHTML,
    }));
    expect(surface.local).toBe(0);
    expect(surface.session).toBe(0);
    expect(surface.cookies).toBe('');
    expect(surface.attributes).toHaveLength(2);
    for (const names of surface.attributes) {
      // `lang` is the documented a11y mirror of the resolved locale on the element itself
      // (web/src/mfe/web-component.tsx); every other attribute is configuration only.
      expect(names).toEqual(['api-base', 'client-id', 'data-idpn-mfe', 'dir', 'lang', 'locale']);
    }
    const surfaceLanguages = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-idpn-mfe]')).map((element) =>
        element.getAttribute('lang'),
      ),
    );
    expect(surfaceLanguages).toEqual(['fa-IR', 'fa-IR']);
    expect(surface.html).not.toMatch(/bearer\s|access.?token|eyJ[A-Za-z0-9_-]{8,}\./i);

    expect(consoleErrors).toEqual([]);
  });

  test('keeps host and module styles isolated and Radix portals inside the shadow root', async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto('/host/');
    await expect(page.getByRole('heading', { name: 'مدیریت کاربران' })).toBeVisible();

    // Host styles survive: no global reset/preflight and no utility override.
    await expect(page.locator('#host-title')).toHaveCSS('font-size', '40px');
    await expect(page.locator('#host-button')).toHaveCSS('background-color', 'rgb(200, 0, 0)');
    await expect(page.locator('#host-button')).toHaveCSS('font-size', '24px');
    await expect(page.locator('#host-button')).toHaveCSS('display', 'block');
    await expect(page.locator('#host-button')).toHaveCSS('padding', '1px');
    await expect(page.locator('body')).toHaveCSS('font-family', /Georgia/);

    // The module keeps its own typography, direction and theme tokens.
    const mfeRoot = page.locator('#mfe .idpn-root');
    await expect(mfeRoot).toHaveAttribute('dir', 'rtl');
    await expect(mfeRoot).toHaveAttribute('lang', 'fa-IR');
    await expect(mfeRoot).toHaveCSS('font-family', /Vazirmatn/);

    const rootPrimary = await page
      .locator('#mfe .idpn-root')
      .evaluate((root) => getComputedStyle(root).getPropertyValue('--idpn-primary').trim());
    const documentPrimary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--idpn-primary').trim(),
    );
    expect(rootPrimary).toBe('#0057b8');
    expect(documentPrimary).toBe('');

    const invite = page.getByRole('button', { name: 'دعوت کاربر' });
    const inviteBackground = await invite.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(inviteBackground).not.toBe('rgb(200, 0, 0)');
    expect(inviteBackground).not.toBe('rgba(0, 0, 0, 0)');

    // Radix portals must stay inside the shadow root, never in the host body.
    await invite.click();
    await expect(page.getByRole('dialog', { name: 'دعوت عضو جدید' })).toBeVisible();

    const dialogLocation = await page.evaluate(() => {
      const host = document.querySelector('#mfe on4net-idpn-user-management');
      const root = host?.shadowRoot?.querySelector('.idpn-root') ?? null;
      const dialog = host?.shadowRoot?.querySelector('[role="dialog"]') ?? null;
      return {
        insideShadowRoot: dialog !== null,
        insideIdpnRoot: root !== null && dialog !== null && root.contains(dialog),
        insidePortalRoot: dialog?.closest('[data-idpn-portal-root]') !== null,
        inDocumentBody: document.body.querySelector('[role="dialog"]') !== null,
      };
    });
    expect(dialogLocation).toEqual({
      insideShadowRoot: true,
      insideIdpnRoot: true,
      insidePortalRoot: true,
      inDocumentBody: false,
    });

    // No theme or Tailwind defaults escaped to the host document.
    const rootVariables = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['--idpn-primary', '--primary', '--spacing', '--color-black', '--animate-spin'].map(
        (name) => style.getPropertyValue(name).trim(),
      );
    });
    expect(rootVariables).toEqual(['', '', '', '', '']);

    // The account module owns its own shadow root and styles.
    const accountHost = page.getByTestId('host-slot-account').locator('on4net-idpn-account');
    const accountRoots = await accountHost.evaluate(
      (element) => element.shadowRoot?.querySelectorAll('.idpn-root').length ?? -1,
    );
    expect(accountRoots).toBe(1);
  });

  test('delivers module events once, composed, and without tokens', async ({ page }) => {
    await mockApi(page, { membersStatus: 403 });
    await page.goto('/host/');

    const sdkCount = page.getByTestId('host-event-count');
    const domCount = page.getByTestId('host-bubbled-events');
    const events = page.getByTestId('host-events').locator('li');

    // One failed member request emits exactly one auth:error, through the SDK handler and
    // as the composed `idpn:event` that reached the host document.
    await expect(sdkCount).toHaveText('1');
    await expect(domCount).toHaveText('1');
    await expect(events).toHaveCount(1);
    await expect(events.first()).toHaveText(/"type":"auth:error","code":"forbidden"/);

    const logText = await page.getByTestId('host-events').innerText();
    expect(logText).not.toMatch(/bearer|access.?token|refresh.?token|eyJ/i);

    // Unmounting and re-mounting must not duplicate handlers/listeners: each new mount
    // adds exactly one event per emitted event, not two.
    await page.getByRole('button', { name: 'Unmount modules', exact: true }).click();
    await expect(page.locator('[data-idpn-mfe]')).toHaveCount(0);
    await expect(events).toHaveCount(1);

    await page.getByRole('button', { name: 'Mount modules', exact: true }).click();
    await expect(sdkCount).toHaveText('2');
    await expect(domCount).toHaveText('2');
    await expect(events).toHaveCount(2);
  });

  test('unmount and re-mount leave no duplicated roots or styles', async ({ page }) => {
    await mockApi(page);
    await page.goto('/host/');

    const userManagementRoot = page.getByTestId('host-slot-user-management').locator('.idpn-root');
    const accountRoot = page.getByTestId('host-slot-account').locator('.idpn-root');
    await expect(userManagementRoot).toHaveCount(1);
    await expect(accountRoot).toHaveCount(1);

    await page.getByRole('button', { name: 'Unmount modules', exact: true }).click();
    await expect(page.locator('[data-idpn-mfe]')).toHaveCount(0);
    await expect(userManagementRoot).toHaveCount(0);
    await expect(accountRoot).toHaveCount(0);
    await expect(page.getByTestId('host-status')).toContainText('Modules are unmounted');

    await page.getByRole('button', { name: 'Mount modules', exact: true }).click();
    await expect(userManagementRoot).toHaveCount(1);
    await expect(accountRoot).toHaveCount(1);

    // Mounting again without unmounting replaces the element instead of stacking roots.
    await page.getByRole('button', { name: 'Mount modules', exact: true }).click();
    await expect(page.locator('[data-idpn-mfe]')).toHaveCount(2);
    await expect(userManagementRoot).toHaveCount(1);
    await expect(accountRoot).toHaveCount(1);

    const shadow = await page.locator('#mfe on4net-idpn-user-management').evaluate((host) => ({
      roots: host.shadowRoot?.querySelectorAll('.idpn-root').length ?? -1,
      styles: host.shadowRoot?.querySelectorAll('style').length ?? -1,
      children: host.shadowRoot?.children.length ?? -1,
    }));
    expect(shadow).toEqual({ roots: 1, styles: 1, children: 2 });
  });

  test('shows a safe fallback when the bundle cannot load', async ({ page }) => {
    await page.goto('/host/broken.html');

    const fallback = page.getByTestId('host-fallback');
    await expect(fallback).toBeVisible();
    await expect(fallback).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('host-fallback-message')).toContainText(
      'could not be loaded from /host/missing-web-component.js',
    );

    const link = page.getByTestId('host-fallback-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', HOSTED_LOGIN_URL);
    await expect(page.locator('[data-idpn-mfe]')).toHaveCount(0);

    // The error surface must not echo tokens, stack traces or internal URLs.
    const text = await fallback.innerText();
    expect(text).not.toMatch(/bearer|access.?token|eyJ|node_modules/i);
  });
});
