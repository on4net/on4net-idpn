import { describe, expect, it } from 'vitest';

import {
  fakeFetch,
  hangingFetch,
  jsonResponse,
  malformedResponse,
  type FakeFetch,
  type RecordedRequest,
} from '../../test/social-fixtures.js';
import { FacebookSocialAdapter, FACEBOOK_GRAPH_BASE_URL } from './facebook.js';
import {
  SocialAdapterError,
  assertVerifiedEmail,
  type AuthorizationCodeExchange,
} from './types.js';

const CLIENT_KEY = '1234567890-app-a';
const CLIENT_SECRET = 'facebook-app-a-secret';
const AUTH_CODE = 'facebook-auth-code-1';
const ACCESS_TOKEN = 'EAAB-facebook-user-token';

const exchange: AuthorizationCodeExchange = {
  code: AUTH_CODE,
  redirectUri: 'https://auth.example.com/oauth2/social/platform-a/facebook/callback',
  clientKey: CLIENT_KEY,
  clientSecret: CLIENT_SECRET,
  codeVerifier: 'pkce-verifier-1',
};

const tokenResponse = (): Response =>
  jsonResponse({ access_token: ACCESS_TOKEN, token_type: 'bearer' });
const debugResponse = (data: Record<string, unknown> = {}): Response =>
  jsonResponse({ data: { is_valid: true, app_id: CLIENT_KEY, user_id: 'fb-user-1', ...data } });
const profileResponse = (body: Record<string, unknown> = {}): Response =>
  jsonResponse({
    id: 'fb-user-1',
    name: 'Grace Hopper',
    email: 'grace@example.com',
    picture: { data: { url: 'https://scontent.xx.fbcdn.net/photo.jpg' } },
    ...body,
  });

function createAdapter(fake: FakeFetch): FacebookSocialAdapter {
  return new FacebookSocialAdapter({ fetch: fake.fetch, sleep: async () => {} });
}

function requestAt(fake: FakeFetch, index: number): RecordedRequest {
  const request = fake.requests[index];
  if (request === undefined) {
    throw new Error(`request #${index + 1} was not recorded`);
  }
  return request;
}

async function captureError(run: () => Promise<unknown>): Promise<SocialAdapterError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SocialAdapterError);
    return error as SocialAdapterError;
  }
  throw new Error('expected the adapter to fail');
}

describe('FacebookSocialAdapter', () => {
  it('exchanges the code, validates the token and maps the Graph profile', async () => {
    const fake = fakeFetch(
      () => tokenResponse(),
      () => debugResponse(),
      () => profileResponse(),
    );

    const profile = await createAdapter(fake).exchangeAuthorizationCode(exchange);

    expect(profile).toEqual({
      provider: 'facebook',
      providerUserId: 'fb-user-1',
      email: 'grace@example.com',
      emailVerified: false,
      displayName: 'Grace Hopper',
      avatarUrl: 'https://scontent.xx.fbcdn.net/photo.jpg',
      locale: null,
    });
    expect(profile.raw).toBeUndefined();

    expect(fake.requests).toHaveLength(3);

    const token = requestAt(fake, 0);
    expect(token.url.origin + token.url.pathname).toBe(
      `${FACEBOOK_GRAPH_BASE_URL}/oauth/access_token`,
    );
    expect(token.url.searchParams.get('client_id')).toBe(CLIENT_KEY);
    expect(token.url.searchParams.get('client_secret')).toBe(CLIENT_SECRET);
    expect(token.url.searchParams.get('redirect_uri')).toBe(exchange.redirectUri);
    expect(token.url.searchParams.get('code')).toBe(AUTH_CODE);
    expect(token.url.searchParams.get('code_verifier')).toBe('pkce-verifier-1');

    const debug = requestAt(fake, 1);
    expect(debug.url.origin + debug.url.pathname).toBe(`${FACEBOOK_GRAPH_BASE_URL}/debug_token`);
    expect(debug.url.searchParams.get('input_token')).toBe(ACCESS_TOKEN);
    expect(debug.url.searchParams.get('access_token')).toBe(`${CLIENT_KEY}|${CLIENT_SECRET}`);

    const me = requestAt(fake, 2);
    expect(me.url.origin + me.url.pathname).toBe(`${FACEBOOK_GRAPH_BASE_URL}/me`);
    expect(me.url.searchParams.get('fields')).toContain('picture.type(large)');
    // The user token travels in the header, never in the URL.
    expect(me.url.searchParams.get('access_token')).toBeNull();
    expect(me.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('always reports Facebook email as unverified', async () => {
    const fake = fakeFetch(
      () => tokenResponse(),
      () => debugResponse(),
      () => profileResponse(),
    );

    const profile = await createAdapter(fake).exchangeAuthorizationCode(exchange);

    expect(profile.email).toBe('grace@example.com');
    expect(profile.emailVerified).toBe(false);

    const error = await captureError(async () => assertVerifiedEmail(profile));
    expect(error.code).toBe('email_unverified');
    expect(error.provider).toBe('facebook');
  });

  it('maps a provider rejection to invalid_grant without retrying or leaking credentials', async () => {
    const fake = fakeFetch(() => jsonResponse({ error: { message: 'bad code' } }, 400));

    const error = await captureError(() => createAdapter(fake).exchangeAuthorizationCode(exchange));

    expect(error.code).toBe('invalid_grant');
    expect(error.provider).toBe('facebook');
    expect(error.retryable).toBe(false);
    expect(fake.requests).toHaveLength(1);
    expect(error.message).not.toContain(CLIENT_SECRET);
    expect(error.message).not.toContain(AUTH_CODE);
    expect(error.message).not.toContain(ACCESS_TOKEN);
  });

  it('treats a 200 response that carries an error object as invalid_grant', async () => {
    const fake = fakeFetch(() => jsonResponse({ error: { message: 'bad code' } }));

    const error = await captureError(() => createAdapter(fake).exchangeAuthorizationCode(exchange));

    expect(error.code).toBe('invalid_grant');
  });

  it('rejects a token that Graph reports as invalid', async () => {
    const fake = fakeFetch(
      () => tokenResponse(),
      () => debugResponse({ is_valid: false }),
    );

    const error = await captureError(() => createAdapter(fake).exchangeAuthorizationCode(exchange));

    expect(error.code).toBe('invalid_grant');
    expect(fake.requests).toHaveLength(2);
  });

  it('rejects a token that belongs to another Facebook app', async () => {
    const fake = fakeFetch(
      () => tokenResponse(),
      () => debugResponse({ app_id: 'other-app' }),
    );

    const error = await captureError(() => createAdapter(fake).exchangeAuthorizationCode(exchange));

    expect(error.code).toBe('invalid_response');
    expect(error.message).toBe('facebook access token was issued to another app');
  });

  it('rejects a token inspection response without an app id', async () => {
    const fake = fakeFetch(
      () => tokenResponse(),
      () => jsonResponse({ data: { is_valid: true } }),
    );

    const error = await captureError(() => createAdapter(fake).exchangeAuthorizationCode(exchange));

    expect(error.code).toBe('invalid_response');
  });

  it('rejects a profile that does not match the token subject', async () => {
    const fake = fakeFetch(
      () => tokenResponse(),
      () => debugResponse({ user_id: 'another-user' }),
      () => profileResponse(),
    );

    const error = await captureError(() => createAdapter(fake).exchangeAuthorizationCode(exchange));

    expect(error.code).toBe('invalid_response');
    expect(error.message).toBe('facebook access token does not belong to this profile');
  });

  it('rejects malformed JSON from the exchange', async () => {
    const fake = fakeFetch(() => malformedResponse());

    const error = await captureError(() => createAdapter(fake).exchangeAuthorizationCode(exchange));

    expect(error.code).toBe('invalid_response');
  });

  it('rejects a malformed profile payload without leaking the access token', async () => {
    const fake = fakeFetch(
      () => tokenResponse(),
      () => debugResponse(),
      () => jsonResponse({ name: 'no id here' }),
    );

    const error = await captureError(() => createAdapter(fake).exchangeAuthorizationCode(exchange));

    expect(error.code).toBe('invalid_response');
    expect(error.message).not.toContain(ACCESS_TOKEN);
    expect(error.message).not.toContain(CLIENT_SECRET);
  });

  it('keeps an absent email absent', async () => {
    const fake = fakeFetch(
      () => tokenResponse(),
      () => debugResponse(),
      () => profileResponse({ email: undefined }),
    );

    const profile = await createAdapter(fake).exchangeAuthorizationCode(exchange);

    expect(profile.email).toBeNull();
    expect(profile.emailVerified).toBe(false);
    expect(profile.displayName).toBe('Grace Hopper');
  });

  it('accepts a plain picture URL and drops unsafe schemes', async () => {
    const plain = fakeFetch(
      () => tokenResponse(),
      () => debugResponse(),
      () => profileResponse({ picture: 'https://scontent.xx.fbcdn.net/plain.jpg' }),
    );

    await expect(createAdapter(plain).exchangeAuthorizationCode(exchange)).resolves.toMatchObject({
      avatarUrl: 'https://scontent.xx.fbcdn.net/plain.jpg',
    });

    const unsafe = fakeFetch(
      () => tokenResponse(),
      () => debugResponse(),
      () => profileResponse({ picture: 'javascript:alert(1)' }),
    );

    await expect(createAdapter(unsafe).exchangeAuthorizationCode(exchange)).resolves.toMatchObject({
      avatarUrl: null,
    });
  });

  it('does not retry a failed code exchange', async () => {
    const fake = fakeFetch(() => jsonResponse({ error: { message: 'down' } }, 503));

    const error = await captureError(() => createAdapter(fake).exchangeAuthorizationCode(exchange));

    expect(error.code).toBe('provider_unavailable');
    expect(error.retryable).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  it('retries an idempotent Graph read after a 5xx', async () => {
    const fake = fakeFetch(
      () => tokenResponse(),
      () => jsonResponse({ error: { message: 'temporary' } }, 503),
      () => debugResponse(),
      () => profileResponse(),
    );

    const profile = await createAdapter(fake).exchangeAuthorizationCode(exchange);

    expect(profile.providerUserId).toBe('fb-user-1');
    expect(fake.requests).toHaveLength(4);
    expect(requestAt(fake, 1).url.pathname).toBe(`${requestAt(fake, 2).url.pathname}`);
  });

  it('reports a timeout as provider_unavailable', async () => {
    const adapter = new FacebookSocialAdapter({ fetch: hangingFetch, timeoutMs: 10 });

    const error = await captureError(() => adapter.exchangeAuthorizationCode(exchange));

    expect(error.code).toBe('provider_unavailable');
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(CLIENT_SECRET);
  });
});
