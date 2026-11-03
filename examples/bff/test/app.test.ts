import { afterEach, describe, expect, it } from 'vitest';

import { buildBffApp } from '../src/app.js';
import type { FetchLike } from '../src/oidc.js';
import type { IdpClientConfig } from '../src/oidc-types.js';
import { InMemoryBffStore } from '../src/store.js';
import { createFakeIdp, type FakeIdp } from './fake-idp.js';

const idpConfig: IdpClientConfig = {
  baseUrl: 'http://127.0.0.1:3100',
  clientId: 'sample-bff',
  clientSecret: 'super-secret-value',
  redirectUri: 'http://127.0.0.1:3200/auth/callback',
  scopes: ['openid', 'profile', 'email'],
};

interface Harness {
  app: ReturnType<typeof buildBffApp>;
  fake: FakeIdp;
  store: InMemoryBffStore;
}

const harnesses: Harness[] = [];

function createHarness(): Harness {
  const fake = createFakeIdp({
    clientId: idpConfig.clientId,
    clientSecret: idpConfig.clientSecret,
  });
  const store = new InMemoryBffStore();
  const app = buildBffApp({ idp: idpConfig, fetchImpl: fake.fetchImpl, store });
  const harness = { app, fake, store };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

const startLogin = async (harness: Harness) => {
  const response = await harness.app.inject({ method: 'GET', url: '/login' });
  expect(response.statusCode).toBe(302);
  const location = new URL(response.headers.location ?? '');
  const setCookie = (response.headers['set-cookie'] as string | undefined) ?? '';
  const tx = /bff_tx=([^;]*)/.exec(setCookie)?.[1] ?? '';
  return { response, location, tx };
};

const completeLogin = async (harness: Harness) => {
  const { location, tx } = await startLogin(harness);
  const state = location.searchParams.get('state') ?? '';
  const code = harness.fake.issueCode({
    challenge: location.searchParams.get('code_challenge') ?? '',
    redirectUri: location.searchParams.get('redirect_uri') ?? '',
    nonce: location.searchParams.get('nonce') ?? '',
  });
  const callback = await harness.app.inject({
    method: 'GET',
    url: `/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
    cookies: { bff_tx: tx },
  });
  expect(callback.statusCode).toBe(302);
  const rawCookie = callback.headers['set-cookie'];
  const cookie = Array.isArray(rawCookie) ? rawCookie.join('; ') : (rawCookie ?? '');
  const sessionId = /bff_session=([^;]+)/.exec(cookie)?.[1] ?? '';
  return { location, callback, cookie, sessionId };
};

describe('GET /login', () => {
  it('redirects with PKCE S256, state and nonce, and sets only the transaction cookie', async () => {
    const harness = createHarness();
    const { response, location, tx } = await startLogin(harness);

    expect(location.origin + location.pathname).toBe('http://127.0.0.1:3100/oauth2/authorize');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('client_id')).toBe('sample-bff');
    expect(location.searchParams.get('redirect_uri')).toBe(idpConfig.redirectUri);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The state is bound to this browser; no session cookie is issued before authentication.
    const setCookie = (response.headers['set-cookie'] as string | undefined) ?? '';
    expect(setCookie).toContain('bff_tx=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('bff_session');
    expect(tx).toBe(location.searchParams.get('state'));
    expect(harness.store.transactionCount).toBe(1);
  });

  it('never exposes the PKCE verifier to the browser', async () => {
    const harness = createHarness();
    const { location } = await startLogin(harness);
    const serialized = location.toString();
    expect(serialized).not.toContain('code_verifier');
    expect(serialized).not.toContain('verifier');
  });

  it('rejects an absolute return_to so the sample app cannot be used as an open redirect', async () => {
    const harness = createHarness();
    const absolute = await harness.app.inject({
      method: 'GET',
      url: '/login?return_to=https://evil.example/steal',
    });
    const protocolRelative = await harness.app.inject({
      method: 'GET',
      url: '/login?return_to=//evil.example/steal',
    });
    const relative = await harness.app.inject({
      method: 'GET',
      url: '/login?return_to=%2Fdashboard',
    });
    // `/\evil.example` is normalised by browsers to `//evil.example` (card #71 finding 1).
    const backslash = await harness.app.inject({
      method: 'GET',
      url: '/login?return_to=%2F%5Cevil.example',
    });
    // `..` segments collapse to a leading `//` only after normalisation, so guarding the raw
    // string is not enough (card #71 finding 1, second round).
    const dotSegments = await harness.app.inject({
      method: 'GET',
      url: '/login?return_to=%2F..%2F%2Fevil.example',
    });
    const encodedDotSegments = await harness.app.inject({
      method: 'GET',
      url: '/login?return_to=%2Fa%2F..%2F%2Fevil.example',
    });
    expect(absolute.headers.location).toContain('/oauth2/authorize');
    expect(protocolRelative.headers.location).toContain('/oauth2/authorize');
    expect(backslash.headers.location).toContain('/oauth2/authorize');
    expect(dotSegments.headers.location).toContain('/oauth2/authorize');
    expect(encodedDotSegments.headers.location).toContain('/oauth2/authorize');

    for (const response of [
      absolute,
      protocolRelative,
      backslash,
      dotSegments,
      encodedDotSegments,
      relative,
    ]) {
      const state = new URL(response.headers.location ?? '').searchParams.get('state') ?? '';
      const stored = await harness.store.takeTransaction(state);
      expect(stored?.returnTo).toBe(response === relative ? '/dashboard' : '/');
    }
  });
});

describe('GET /auth/callback', () => {
  it('exchanges the code, keeps the tokens server-side and sets an HttpOnly session cookie', async () => {
    const harness = createHarness();
    const { callback, cookie, sessionId } = await completeLogin(harness);

    expect(callback.headers.location).toBe('/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('at-');
    expect(cookie).not.toContain('rt-');
    expect(sessionId).not.toBe('');

    const stored = await harness.store.getSession(sessionId);
    expect(stored?.tokens.access_token).toMatch(/^at-\d+$/);
    expect(stored?.tokens.refresh_token).toMatch(/^rt-\d+$/);
    expect(harness.store.transactionCount).toBe(0);
    expect(harness.fake.tokenCallCount()).toBe(1);
  });

  it('renders the profile without leaking any token into the HTML', async () => {
    const harness = createHarness();
    const { cookie } = await completeLogin(harness);

    const page = await harness.app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('sara@example.com');
    expect(page.body).not.toContain('at-');
    expect(page.body).not.toMatch(/refresh_token/i);
  });

  it('answers /api/session with claims only', async () => {
    const harness = createHarness();
    const { cookie } = await completeLogin(harness);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body['authenticated']).toBe(true);
    expect(body['claims']).toMatchObject({ sub: 'user-1' });
    expect(JSON.stringify(body)).not.toContain('at-');
    expect(JSON.stringify(body)).not.toContain('access_token');
  });

  it('rejects an unknown or replayed state without calling the token endpoint', async () => {
    const harness = createHarness();
    const { callback } = await completeLogin(harness);
    const cookie = (callback.headers['set-cookie'] as string | undefined) ?? '';
    expect(cookie).not.toBe('');

    const unknown = await harness.app.inject({
      method: 'GET',
      url: '/auth/callback?code=code-1&state=forged-state',
    });
    expect(unknown.statusCode).toBe(302);
    expect(unknown.headers.location).toBe('/signin-failed?reason=invalid_state');

    const { location } = await startLogin(harness);
    const state = location.searchParams.get('state') ?? '';
    const code = harness.fake.issueCode({
      challenge: location.searchParams.get('code_challenge') ?? '',
      redirectUri: idpConfig.redirectUri,
      nonce: location.searchParams.get('nonce') ?? '',
    });
    const first = await harness.app.inject({
      method: 'GET',
      url: `/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
      cookies: { bff_tx: state },
    });
    expect(first.statusCode).toBe(302);
    const replay = await harness.app.inject({
      method: 'GET',
      url: `/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
      cookies: { bff_tx: state },
    });
    expect(replay.headers.location).toBe('/signin-failed?reason=invalid_state');
    // One exchange for the successful login only; the forged and replayed states never reached it.
    expect(harness.fake.tokenCallCount()).toBe(2);
  });

  it('rejects a callback that was not started by this browser', async () => {
    const harness = createHarness();
    const { location } = await startLogin(harness);
    const state = location.searchParams.get('state') ?? '';
    const code = harness.fake.issueCode({
      challenge: location.searchParams.get('code_challenge') ?? '',
      redirectUri: idpConfig.redirectUri,
      nonce: location.searchParams.get('nonce') ?? '',
    });

    // Valid state, but no transaction cookie: a URL minted for another browser (login CSRF).
    const stolen = await harness.app.inject({
      method: 'GET',
      url: `/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
    });
    expect(stolen.headers.location).toBe('/signin-failed?reason=invalid_state');
    expect(harness.fake.tokenCallCount()).toBe(0);
  });

  it('reports a token exchange failure and offers the Hosted page as fallback', async () => {
    const harness = createHarness();
    const { location, tx } = await startLogin(harness);
    const state = location.searchParams.get('state') ?? '';
    // The code was never issued by the fake IdP, so the exchange fails.
    const callback = await harness.app.inject({
      method: 'GET',
      url: `/auth/callback?code=unknown-code&state=${encodeURIComponent(state)}`,
      cookies: { bff_tx: tx },
    });
    expect(callback.headers.location).toBe(
      '/signin-failed?reason=token_exchange_failed%3Ainvalid_grant',
    );

    const page = await harness.app.inject({
      method: 'GET',
      url: '/signin-failed?reason=token_exchange_failed',
    });
    expect(page.statusCode).toBe(400);
    expect(page.body).toContain('data-testid="hosted-fallback"');
    expect(page.body).toContain('http://127.0.0.1:3100/');
    expect(harness.store.sessionCount).toBe(0);
  });

  it('forwards a caller error from the IdP without exchanging anything', async () => {
    const harness = createHarness();
    const response = await harness.app.inject({
      method: 'GET',
      url: '/auth/callback?error=access_denied&state=whatever',
    });
    expect(response.headers.location).toBe('/signin-failed?reason=access_denied');
    expect(harness.fake.tokenCallCount()).toBe(0);
  });

  it('rejects a callback without code or state', async () => {
    const harness = createHarness();
    const response = await harness.app.inject({ method: 'GET', url: '/auth/callback?code=abc' });
    expect(response.headers.location).toBe('/signin-failed?reason=invalid_request');
    expect(harness.fake.tokenCallCount()).toBe(0);
  });
});

describe('OIDC client hardening', () => {
  const buildApp = (fetchImpl: FetchLike) =>
    buildBffApp({
      idp: idpConfig,
      fetchImpl,
      store: new InMemoryBffStore(),
    });

  it('sends ui_locales and login_hint through to the authorization endpoint', async () => {
    const harness = createHarness();
    const response = await harness.app.inject({
      method: 'GET',
      url: '/login?ui_locales=fa-IR&login_hint=sara%40example.com',
    });
    const location = new URL(response.headers.location ?? '');
    expect(location.searchParams.get('ui_locales')).toBe('fa-IR');
    expect(location.searchParams.get('login_hint')).toBe('sara@example.com');
  });

  it('reports a network failure instead of throwing', async () => {
    const app = buildApp(() => Promise.reject(new Error('ECONNREFUSED')));
    const { location, tx } = await startLoginOn(app);
    const state = location.searchParams.get('state') ?? '';
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=c&state=${encodeURIComponent(state)}`,
      cookies: { bff_tx: tx },
    });
    expect(callback.headers.location).toBe(
      '/signin-failed?reason=token_exchange_failed%3AECONNREFUSED',
    );
    await app.close();
  });

  it('rejects a token response without an access token', async () => {
    const app = buildApp(
      async () =>
        new Response(JSON.stringify({ token_type: 'Bearer' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const { location, tx } = await startLoginOn(app);
    const state = location.searchParams.get('state') ?? '';
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=c&state=${encodeURIComponent(state)}`,
      cookies: { bff_tx: tx },
    });
    expect(callback.headers.location).toBe(
      '/signin-failed?reason=token_exchange_failed%3Ainvalid_token_response',
    );
    await app.close();
  });

  it('reports the HTTP status when the IdP returns a non-JSON error', async () => {
    const app = buildApp(async () => new Response('upstream down', { status: 503 }));
    const { location, tx } = await startLoginOn(app);
    const state = location.searchParams.get('state') ?? '';
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=c&state=${encodeURIComponent(state)}`,
      cookies: { bff_tx: tx },
    });
    expect(callback.headers.location).toBe(
      '/signin-failed?reason=token_exchange_failed%3Ahttp_503',
    );
    await app.close();
  });

  it('clears the session even when the revocation call fails', async () => {
    const harness = createHarness();
    const { cookie, sessionId } = await completeLogin(harness);
    const store = harness.store;
    const failing = buildBffApp({
      idp: idpConfig,
      store,
      fetchImpl: (input, init) =>
        String(input).includes('/oauth2/revoke')
          ? Promise.reject(new Error('offline'))
          : harness.fake.fetchImpl(input, init),
    });

    const logout = await failing.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie },
    });
    expect(logout.headers.location).toBe('/signed-out');
    expect(await store.getSession(sessionId)).toBeNull();
    await failing.close();
  });

  it('treats an unreachable userinfo endpoint as an expired session', async () => {
    const harness = createHarness();
    const { cookie } = await completeLogin(harness);
    const failing = buildBffApp({
      idp: idpConfig,
      store: harness.store,
      fetchImpl: (input, init) =>
        String(input).includes('/oauth2/userinfo')
          ? Promise.reject(new Error('offline'))
          : harness.fake.fetchImpl(input, init),
    });

    const page = await failing.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(page.headers.location).toBe('/signin-failed?reason=session_expired');
    await failing.close();
  });
});

describe('InMemoryBffStore', () => {
  it('drops expired transactions and sessions', async () => {
    let clock = 1_000;
    const store = new InMemoryBffStore(() => clock);
    await store.saveTransaction({
      state: 's',
      nonce: 'n',
      codeVerifier: 'v',
      returnTo: '/',
      expiresAt: clock + 10,
    });
    await store.createSession({
      id: 'sid',
      tokens: { access_token: 'at', token_type: 'Bearer', expires_in: 60 },
      expiresAt: clock + 10,
    });

    clock += 20;
    expect(await store.takeTransaction('s')).toBeNull();
    expect(await store.getSession('sid')).toBeNull();
    expect(await store.takeTransaction('missing')).toBeNull();
    expect(await store.getSession('missing')).toBeNull();
  });
});

const startLoginOn = async (app: ReturnType<typeof buildBffApp>) => {
  const response = await app.inject({ method: 'GET', url: '/login' });
  const setCookie = (response.headers['set-cookie'] as string | undefined) ?? '';
  const tx = /bff_tx=([^;]*)/.exec(setCookie)?.[1] ?? '';
  return { response, location: new URL(response.headers.location ?? ''), tx };
};

describe('session lifecycle', () => {
  it('sends visitors without a session to /login', async () => {
    const harness = createHarness();
    const root = await harness.app.inject({ method: 'GET', url: '/' });
    const session = await harness.app.inject({ method: 'GET', url: '/api/session' });
    const refresh = await harness.app.inject({ method: 'POST', url: '/refresh' });

    expect(root.headers.location).toBe('/login');
    expect(session.json()).toEqual({ authenticated: false });
    expect(refresh.headers.location).toBe('/login');
  });

  it('rotates the refresh token on POST /refresh and keeps the same browser session', async () => {
    const harness = createHarness();
    const { cookie, sessionId } = await completeLogin(harness);
    const before = await harness.store.getSession(sessionId);
    const oldRefresh = before?.tokens.refresh_token ?? '';

    const refreshed = await harness.app.inject({
      method: 'POST',
      url: '/refresh',
      headers: { cookie },
    });
    expect(refreshed.headers.location).toBe('/');
    expect(refreshed.headers['set-cookie']).toBeUndefined();

    const after = await harness.store.getSession(sessionId);
    expect(after?.tokens.refresh_token).not.toBe(oldRefresh);
    expect(harness.fake.refreshTokenState(oldRefresh)?.rotated).toBe(true);

    const page = await harness.app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain(after?.tokens.access_token ?? 'never-matches');
  });

  it('refreshes transparently when the access token expires', async () => {
    const harness = createHarness();
    const { cookie, sessionId } = await completeLogin(harness);
    const before = await harness.store.getSession(sessionId);

    harness.fake.expireAccessTokens();
    const page = await harness.app.inject({ method: 'GET', url: '/', headers: { cookie } });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('sara@example.com');
    const after = await harness.store.getSession(sessionId);
    expect(after?.tokens.access_token).not.toBe(before?.tokens.access_token);
  });

  it('discards the session when a refresh fails', async () => {
    const harness = createHarness();
    const { cookie, sessionId } = await completeLogin(harness);
    await harness.app.inject({ method: 'POST', url: '/refresh', headers: { cookie } });

    const current = await harness.store.getSession(sessionId);
    expect(current).not.toBeNull();
    // The IdP revoked the current token (logout at another client, admin action, reuse detected).
    harness.fake.revokeRefreshToken(current?.tokens.refresh_token ?? '');

    const rejected = await harness.app.inject({
      method: 'POST',
      url: '/refresh',
      headers: { cookie },
    });
    expect(rejected.headers.location).toBe('/signin-failed?reason=refresh_failed');
    expect(rejected.headers['set-cookie']).toContain('Max-Age=0');
    expect(await harness.store.getSession(sessionId)).toBeNull();
  });

  it('revokes the refresh token, drops the session and clears the cookie on logout', async () => {
    const harness = createHarness();
    const { cookie, sessionId } = await completeLogin(harness);
    const stored = await harness.store.getSession(sessionId);
    const refreshToken = stored?.tokens.refresh_token ?? '';

    const logout = await harness.app.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie },
    });
    expect(logout.headers.location).toBe('/signed-out');
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect(harness.fake.refreshTokenState(refreshToken)?.revoked).toBe(true);
    expect(await harness.store.getSession(sessionId)).toBeNull();

    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie },
    });
    expect(after.json()).toEqual({ authenticated: false });
  });

  it('clears the session when the profile cannot be loaded', async () => {
    const harness = createHarness();
    const { cookie, sessionId } = await completeLogin(harness);
    const stored = await harness.store.getSession(sessionId);
    if (stored === null) {
      throw new Error('expected a stored session');
    }
    const { refresh_token: _omitted, ...tokensWithoutRefresh } = stored.tokens;
    await harness.store.updateSession(sessionId, { ...stored, tokens: tokensWithoutRefresh });
    harness.fake.expireAccessTokens();

    const page = await harness.app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(page.headers.location).toBe('/signin-failed?reason=session_expired');
    expect(page.headers['set-cookie']).toContain('Max-Age=0');
    expect(await harness.store.getSession(sessionId)).toBeNull();
  });
});
