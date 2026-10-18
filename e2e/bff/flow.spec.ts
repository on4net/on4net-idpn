import { expect, test, type Cookie } from '@playwright/test';

const identifier = process.env.E2E_USER_IDENTIFIER ?? 'user@example.com';
const password = process.env.E2E_USER_PASSWORD ?? 'e2e-user-password-123';

const bffSessionCookie = (cookies: Cookie[]) =>
  cookies.find((cookie) => cookie.name === 'bff_session');

test.describe('sample BFF end-to-end', () => {
  test('signs in through the Hosted UI, refreshes and signs out with server-side tokens', async ({
    page,
    context,
  }) => {
    await page.goto('/');

    // `/` → `/login` → IdP /oauth2/authorize → Hosted login page (no IdP session yet).
    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();
    await page.getByLabel('ایمیل یا نام کاربری').fill(identifier);
    await page.getByLabel('رمز عبور').fill(password);
    await page.getByRole('button', { name: 'ورود' }).click();

    await expect(page.getByTestId('signed-in')).toBeVisible();
    await expect(page.getByTestId('claims')).toContainText(identifier);

    const sessionBefore = bffSessionCookie(await context.cookies());
    expect(sessionBefore?.httpOnly).toBe(true);
    expect(sessionBefore?.sameSite).toBe('Lax');

    const browserState = await page.evaluate(() => ({
      localStorage: { ...localStorage },
      sessionStorage: { ...sessionStorage },
      cookie: document.cookie,
    }));
    const serialized = JSON.stringify(browserState).toLowerCase();
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');
    expect(serialized).not.toContain('id_token');
    // The session cookie is HttpOnly, so the page itself cannot read it back.
    expect(browserState.cookie).not.toContain('bff_session');

    const session = await page.request.get('/api/session');
    const sessionBody = await session.text();
    expect(JSON.parse(sessionBody)).toMatchObject({ authenticated: true });
    expect(sessionBody).not.toContain('access_token');

    await page.getByTestId('refresh').click();
    await expect(page.getByTestId('signed-in')).toBeVisible();
    await expect(page.getByTestId('claims')).toContainText(identifier);
    // Tokens rotate server-side; the browser keeps the same opaque session id.
    expect(bffSessionCookie(await context.cookies())?.value).toBe(sessionBefore?.value);

    await page.getByTestId('logout').click();
    await expect(page.getByTestId('signed-out')).toBeVisible();
    expect(bffSessionCookie(await context.cookies())).toBeUndefined();

    // The IdP single sign-on session is still alive, so the BFF signs in again silently with a
    // brand new session: local logout never reuses the discarded one.
    await page.goto('/');
    await expect(page.getByTestId('signed-in')).toBeVisible();
    const silentSso = bffSessionCookie(await context.cookies());
    expect(silentSso?.value).not.toBe(sessionBefore?.value);

    await context.clearCookies();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();
  });

  test('rejects a callback whose state was never issued', async ({ page }) => {
    await page.goto('/auth/callback?code=forged-code&state=forged-state');

    await expect(page.getByTestId('signin-failed')).toBeVisible();
    await expect(page.getByTestId('reason')).toHaveText('invalid_state');
    // The Hosted page stays available as a manual fallback.
    await expect(page.getByTestId('hosted-fallback')).toHaveAttribute('href', /.+/);
    await expect(page.getByTestId('hosted-fallback')).toContainText('Hosted sign-in page');
    expect(bffSessionCookie(await page.context().cookies())).toBeUndefined();
  });

  test('redirects the browser to the authorization endpoint with PKCE and no tokens', async ({
    request,
  }) => {
    const response = await request.get('/login', { maxRedirects: 0 });

    expect(response.status()).toBe(302);
    const location = new URL(response.headers()['location'] ?? '');
    expect(location.pathname).toBe('/oauth2/authorize');
    expect(location.searchParams.get('client_id')).toBe('sample-bff');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(location.searchParams.get('nonce')).toBeTruthy();
    expect(location.toString()).not.toContain('code_verifier');
    expect(response.headers()['set-cookie']).toBeUndefined();
  });
});
