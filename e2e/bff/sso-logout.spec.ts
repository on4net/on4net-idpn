import { createHash, randomBytes } from 'node:crypto';

import { expect, test } from '@playwright/test';

const identifier = process.env.E2E_USER_IDENTIFIER ?? 'user@example.com';
const password = process.env.E2E_USER_PASSWORD ?? 'e2e-user-password-123';
const idpUrl = process.env.E2E_IDP_URL ?? 'http://127.0.0.1:3100';
const secondClientId = process.env.E2E_SECOND_CLIENT_ID ?? 'sample-bff-b';
const secondRedirectUri =
  process.env.E2E_SECOND_REDIRECT_URI ?? 'http://127.0.0.1:3201/auth/callback';

const base64url = (value: Buffer): string => value.toString('base64url');

test.describe('SSO and logout across two apps', () => {
  test('signs in once, issues a code to a second client without a login and rejects it after logout', async ({
    page,
    context,
  }) => {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));
    const nonce = base64url(randomBytes(16));

    const authorizeUrl = new URL('/oauth2/authorize', idpUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', secondClientId);
    authorizeUrl.searchParams.set('redirect_uri', secondRedirectUri);
    authorizeUrl.searchParams.set('scope', 'openid profile email');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('nonce', nonce);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    // Silent request: an interactive redirect would mean SSO failed.
    authorizeUrl.searchParams.set('prompt', 'none');

    // App A signs in through the Hosted UI and establishes the IdP session.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();
    await page.getByLabel('ایمیل یا نام کاربری').fill(identifier);
    await page.getByLabel('رمز عبور').fill(password);
    await page.getByRole('button', { name: 'ورود' }).click();
    await expect(page.getByTestId('signed-in')).toBeVisible();

    const idpSession = (await context.cookies()).find((cookie) => cookie.name === 'idpn_session');
    expect(idpSession?.httpOnly).toBe(true);
    expect(idpSession?.sameSite).toBe('Lax');

    // App B obtains a code from the same session: no login page, no second credential prompt.
    const sso = await page.request.get(authorizeUrl.toString(), { maxRedirects: 0 });
    expect(sso.status()).toBe(302);
    const ssoLocation = new URL(sso.headers()['location'] ?? '');
    expect(`${ssoLocation.origin}${ssoLocation.pathname}`).toBe(secondRedirectUri);
    expect(ssoLocation.searchParams.get('state')).toBe(state);
    expect(ssoLocation.searchParams.get('code')).toBeTruthy();
    expect(ssoLocation.searchParams.get('error')).toBeNull();

    // The second app never sees a token in browser-readable storage.
    const browserState = await page.evaluate(() => ({
      localStorage: { ...localStorage },
      sessionStorage: { ...sessionStorage },
      cookie: document.cookie,
    }));
    const serialized = JSON.stringify(browserState).toLowerCase();
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');
    expect(serialized).not.toContain('id_token');
    expect(browserState.cookie).not.toContain('idpn_session');

    // Global logout clears the IdP session cookie and revokes the session.
    const logout = await page.request.get(new URL('/oauth2/logout', idpUrl).toString(), {
      maxRedirects: 0,
    });
    expect(logout.status()).toBe(204);
    expect(
      (await context.cookies()).find((cookie) => cookie.name === 'idpn_session'),
    ).toBeUndefined();

    // With the session gone, the same silent request for app B must fail with login_required.
    const denied = await page.request.get(authorizeUrl.toString(), { maxRedirects: 0 });
    expect(denied.status()).toBe(302);
    const deniedLocation = new URL(denied.headers()['location'] ?? '');
    const deniedRedirect = `${deniedLocation.origin}${deniedLocation.pathname}`;
    expect(deniedRedirect).toBe(secondRedirectUri);
    expect(deniedLocation.searchParams.get('error')).toBe('login_required');
    expect(deniedLocation.searchParams.get('state')).toBe(state);
    expect(deniedLocation.searchParams.get('code')).toBeNull();
  });
});
