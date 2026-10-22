import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const CLIENT_ID = 'app-a';
const LOGIN_URL = `${process.env.E2E_WEB_URL ?? 'http://127.0.0.1:5180'}/oauth2/authorize`;

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
  /** Return a Problem Details response instead of the member page. */
  membersStatus?: number;
}

/**
 * The host fixture has no API server. Deterministic responses let the tests exercise the
 * federated modules (and their error surface) instead of transport noise.
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

test.describe('module federation host', () => {
  test('mounts both remotes with the configured client id and BFF session', async ({ page }) => {
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

    // Hostile query string: neither clientId, loginContext nor mode may come from the URL.
    await page.goto('/?clientId=attacker&loginContext=other&mode=spa');

    const userManagementRoot = page.locator(
      '[data-testid="idpn-host-slot-user-management"] .idpn-root',
    );
    await expect(userManagementRoot).toBeVisible();
    await expect(userManagementRoot).toHaveAttribute('dir', 'rtl');
    await expect(userManagementRoot).toHaveAttribute('lang', 'fa-IR');
    await expect(page.getByRole('heading', { name: 'مدیریت کاربران' })).toBeVisible();
    await expect(
      page.getByTestId('idpn-host-slot-user-management').getByText('نگار کریمی'),
    ).toBeVisible();

    const accountRoot = page.locator('[data-testid="idpn-host-slot-account"] .idpn-root');
    await expect(accountRoot).toBeVisible();
    await expect(page.getByRole('heading', { name: 'حساب کاربری' })).toBeVisible();

    // The host shell reports the build-time configuration it actually used.
    await expect(page.getByTestId('idpn-host-client-id')).toHaveText(CLIENT_ID);
    await expect(page.getByTestId('idpn-host-mode')).toHaveText('bff');
    await expect(page.getByTestId('idpn-host-login-context')).toHaveText('admin');
    await expect(page.getByTestId('idpn-host-locale')).toHaveText('fa-IR (rtl)');

    // Every member call is scoped to the configured client, and no request carried a token.
    const memberUrls = apiRequests.filter((url) => url.includes('/members'));
    expect(memberUrls.length).toBeGreaterThan(0);
    for (const url of memberUrls) {
      expect(new URL(url).pathname).toBe(`/api/v1/clients/${CLIENT_ID}/members`);
    }
    expect(apiRequests.some((url) => url.includes('attacker'))).toBe(false);
    expect(authorizationHeaders).toEqual([]);

    // BFF mode keeps the browser clean.
    const storage = await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookies: document.cookie,
    }));
    expect(storage).toEqual({ local: 0, session: 0, cookies: '' });

    expect(consoleErrors).toEqual([]);
  });

  test('isolates host and MFE styles, tokens and portals', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'مدیریت کاربران' })).toBeVisible();

    // MFE styles do not reset or restyle the host (host preflight/utilities stay intact).
    await expect(page.locator('#host-title')).toHaveCSS('font-size', '40px');
    await expect(page.locator('#host-button')).toHaveCSS('background-color', 'rgb(200, 0, 0)');
    await expect(page.locator('#host-button')).toHaveCSS('font-size', '24px');
    await expect(page.locator('#host-paragraph')).toHaveCSS('display', 'block');
    await expect(page.locator('body')).toHaveCSS('font-family', /Georgia/);

    // MFE utilities are scoped to `.idpn-root`; a host element carrying a class that only
    // the remote stylesheet defines must keep the browser default.
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.id = 'host-unscoped-probe';
      probe.className = 'start-4';
      document.body.append(probe);
    });
    await expect(page.locator('#host-unscoped-probe')).toHaveCSS('inset-inline-start', 'auto');

    // The host does not restyle the MFE: its own typography and controls win.
    const mfeRoot = page.locator('[data-testid="idpn-host-slot-user-management"] .idpn-root');
    await expect(mfeRoot).toHaveCSS('font-family', /Vazirmatn/);

    const invite = page.getByRole('button', { name: 'دعوت کاربر' });
    const inviteBackground = await invite.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(inviteBackground).not.toBe('rgb(200, 0, 0)');
    expect(inviteBackground).not.toBe('rgba(0, 0, 0, 0)');
    // Host Preflight resets button padding/font; the module's scoped utilities must win.
    await expect(invite).toHaveCSS('padding-top', '8px');
    await expect(invite).toHaveCSS('font-size', '14px');
    await expect(invite).toHaveCSS('font-family', /Vazirmatn/);

    // Client theme tokens are scoped to `.idpn-root`, never to `:root`.
    const tokens = await page.evaluate(() => {
      const root = document.querySelector(
        '[data-testid="idpn-host-slot-user-management"] .idpn-root',
      );
      const styles = root === null ? null : getComputedStyle(root);
      const documentStyles = getComputedStyle(document.documentElement);
      return {
        rootPrimary: styles?.getPropertyValue('--idpn-primary').trim() ?? '',
        documentPrimary: documentStyles.getPropertyValue('--idpn-primary').trim(),
      };
    });
    expect(tokens.rootPrimary).toBe('#0057b8');
    expect(tokens.documentPrimary).toBe('');

    // Radix portals render inside the MFE root, not in the host body.
    await invite.click();
    await expect(page.getByRole('dialog', { name: 'دعوت عضو جدید' })).toBeVisible();
    const dialogLocation = await page.evaluate(() => {
      const root = document.querySelector(
        '[data-testid="idpn-host-slot-user-management"] .idpn-root',
      );
      const dialog = root?.querySelector('[role="dialog"]') ?? null;
      return {
        insideMfeRoot: dialog !== null,
        insidePortalRoot: dialog?.closest('[data-idpn-portal-root]') !== null,
        inDocumentBody: document.body.querySelector(':scope > [role="dialog"]') !== null,
      };
    });
    expect(dialogLocation).toEqual({
      insideMfeRoot: true,
      insidePortalRoot: true,
      inDocumentBody: false,
    });

    // A host Preflight reset must not remove the module's own elevation/border styles.
    await expect(page.getByRole('dialog', { name: 'دعوت عضو جدید' })).toHaveCSS(
      'border-top-width',
      '1px',
    );
    await expect(page.getByRole('dialog', { name: 'دعوت عضو جدید' })).not.toHaveCSS(
      'box-shadow',
      'none',
    );

    await page.keyboard.press('Escape');

    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations
      .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
      .map((violation) => `${violation.id}: ${violation.help}`);
    expect(blocking).toEqual([]);
  });

  test('shows the hosted fallback link when the remote cannot be loaded', async ({ page }) => {
    await page.route('**/remote/remoteEntry.js', (route) => route.abort());
    await page.goto('/');

    const fallback = page.getByTestId('idpn-user-management-fallback');
    await expect(fallback).toBeVisible();
    await expect(fallback).toHaveAttribute('role', 'alert');
    await expect(fallback).toContainText('The User management module is unavailable.');
    await expect(page.getByTestId('idpn-user-management-fallback-link')).toHaveAttribute(
      'href',
      LOGIN_URL,
    );

    // Each module has its own boundary: both offer the documented Hosted page.
    await expect(page.getByTestId('idpn-account-fallback')).toBeVisible();
    await expect(page.getByTestId('idpn-account-fallback-link')).toHaveAttribute('href', LOGIN_URL);
  });

  test('surfaces remote auth errors accessibly without logging tokens', async ({ page }) => {
    const consoleMessages: string[] = [];
    page.on('console', (message) => consoleMessages.push(message.text()));
    await mockApi(page, { membersStatus: 403 });

    await page.goto('/');

    const alert = page.getByTestId('idpn-host-error');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('idpn-host-error-code')).toHaveText('forbidden');

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('idpn-host-error')).toBeHidden();

    const logs = consoleMessages.join('\n');
    expect(logs).toContain('[idpn-host] auth:error');
    expect(logs).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\./);
    expect(logs).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/);
  });
});
