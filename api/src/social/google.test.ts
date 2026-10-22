import { describe, expect, it } from 'vitest';

import {
  createIdTokenSigner,
  fakeFetch,
  hangingFetch,
  jsonResponse,
  malformedResponse,
  nowSeconds,
  type FakeFetch,
  type IdTokenSigner,
  type RecordedRequest,
} from '../../test/social-fixtures.js';
import { GoogleSocialAdapter, GOOGLE_TOKEN_ENDPOINT } from './google.js';
import {
  SocialAdapterError,
  assertVerifiedEmail,
  type AuthorizationCodeExchange,
} from './types.js';

const CLIENT_KEY = '1234567890-app-a.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-app-a-secret';
const AUTH_CODE = 'google-auth-code-1';
const NONCE = 'nonce-1';

const exchange: AuthorizationCodeExchange = {
  code: AUTH_CODE,
  redirectUri: 'https://auth.example.com/oauth2/social/platform-a/google/callback',
  clientKey: CLIENT_KEY,
  clientSecret: CLIENT_SECRET,
  codeVerifier: 'pkce-verifier-1',
  nonce: NONCE,
};

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowSeconds();
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_KEY,
    sub: 'google-user-1',
    email: 'ada@example.com',
    email_verified: true,
    name: 'Ada Lovelace',
    picture: 'https://lh3.googleusercontent.com/a/photo',
    locale: 'en-GB',
    nonce: NONCE,
    iat: now - 10,
    exp: now + 300,
    ...overrides,
  };
}

function createAdapter(fake: FakeFetch, signer: IdTokenSigner): GoogleSocialAdapter {
  return new GoogleSocialAdapter({ fetch: fake.fetch, keyResolver: signer.keyResolver });
}

function firstRequest(fake: FakeFetch): RecordedRequest {
  const request = fake.requests[0];
  if (request === undefined) {
    throw new Error('no request was recorded');
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

describe('GoogleSocialAdapter', () => {
  it('exchanges a code and maps the verified ID token claims', async () => {
    const signer = await createIdTokenSigner();
    const idToken = await signer.sign(baseClaims());
    const fake = fakeFetch(() =>
      jsonResponse({
        access_token: 'google-access-token',
        id_token: idToken,
        token_type: 'Bearer',
      }),
    );

    const profile = await createAdapter(fake, signer).exchangeAuthorizationCode(exchange);

    expect(profile).toEqual({
      provider: 'google',
      providerUserId: 'google-user-1',
      email: 'ada@example.com',
      emailVerified: true,
      displayName: 'Ada Lovelace',
      avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
      locale: 'en-GB',
    });
    // Nothing provider-specific is retained by default.
    expect(profile.raw).toBeUndefined();

    const request = firstRequest(fake);
    expect(request.method).toBe('POST');
    expect(request.url.toString()).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(request.body ?? '');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe(AUTH_CODE);
    expect(form.get('redirect_uri')).toBe(exchange.redirectUri);
    expect(form.get('client_id')).toBe(CLIENT_KEY);
    expect(form.get('client_secret')).toBe(CLIENT_SECRET);
    expect(form.get('code_verifier')).toBe('pkce-verifier-1');
  });

  it('omits the PKCE verifier when the login did not use PKCE', async () => {
    const signer = await createIdTokenSigner();
    const idToken = await signer.sign(baseClaims());
    const fake = fakeFetch(() => jsonResponse({ id_token: idToken }));

    await createAdapter(fake, signer).exchangeAuthorizationCode({
      code: AUTH_CODE,
      redirectUri: exchange.redirectUri,
      clientKey: CLIENT_KEY,
      clientSecret: CLIENT_SECRET,
      nonce: NONCE,
    });

    expect(new URLSearchParams(firstRequest(fake).body ?? '').has('code_verifier')).toBe(false);
  });

  it('accepts the legacy issuer without a scheme', async () => {
    const signer = await createIdTokenSigner();
    const idToken = await signer.sign(baseClaims({ iss: 'accounts.google.com' }));
    const fake = fakeFetch(() => jsonResponse({ id_token: idToken }));

    await expect(
      createAdapter(fake, signer).exchangeAuthorizationCode(exchange),
    ).resolves.toMatchObject({ providerUserId: 'google-user-1' });
  });

  it('maps a provider rejection to invalid_grant without retrying or leaking credentials', async () => {
    const signer = await createIdTokenSigner();
    const fake = fakeFetch(() => jsonResponse({ error: 'invalid_grant' }, 400));

    const error = await captureError(() =>
      createAdapter(fake, signer).exchangeAuthorizationCode(exchange),
    );

    expect(error.code).toBe('invalid_grant');
    expect(error.provider).toBe('google');
    expect(error.retryable).toBe(false);
    expect(fake.requests).toHaveLength(1);
    expect(error.message).not.toContain(CLIENT_SECRET);
    expect(error.message).not.toContain(AUTH_CODE);
  });

  it('treats a 200 response that carries an error as invalid_grant', async () => {
    const signer = await createIdTokenSigner();
    const fake = fakeFetch(() => jsonResponse({ error: 'invalid_grant' }));

    const error = await captureError(() =>
      createAdapter(fake, signer).exchangeAuthorizationCode(exchange),
    );

    expect(error.code).toBe('invalid_grant');
    expect(fake.requests).toHaveLength(1);
  });

  it('does not retry a failed code exchange', async () => {
    const signer = await createIdTokenSigner();
    const fake = fakeFetch(() => jsonResponse({ error: 'backend_error' }, 503));

    const error = await captureError(() =>
      createAdapter(fake, signer).exchangeAuthorizationCode(exchange),
    );

    expect(error.code).toBe('provider_unavailable');
    expect(error.retryable).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  it('reports a timeout as provider_unavailable', async () => {
    const signer = await createIdTokenSigner();
    const adapter = new GoogleSocialAdapter({
      fetch: hangingFetch,
      keyResolver: signer.keyResolver,
      timeoutMs: 10,
    });

    const error = await captureError(() => adapter.exchangeAuthorizationCode(exchange));

    expect(error.code).toBe('provider_unavailable');
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(CLIENT_SECRET);
  });

  it('rejects malformed JSON as invalid_response', async () => {
    const signer = await createIdTokenSigner();
    const fake = fakeFetch(() => malformedResponse());

    const error = await captureError(() =>
      createAdapter(fake, signer).exchangeAuthorizationCode(exchange),
    );

    expect(error.code).toBe('invalid_response');
    expect(fake.requests).toHaveLength(1);
  });

  it('rejects a token issued for another audience', async () => {
    const signer = await createIdTokenSigner();
    const idToken = await signer.sign(
      baseClaims({ aud: 'another-app.apps.googleusercontent.com' }),
    );
    const fake = fakeFetch(() => jsonResponse({ id_token: idToken }));

    const error = await captureError(() =>
      createAdapter(fake, signer).exchangeAuthorizationCode(exchange),
    );

    expect(error.code).toBe('invalid_response');
    expect(error.message).toBe('google ID token failed validation');
    // Only the stable jose code is chained; claims never travel through the cause.
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe('ERR_JWT_CLAIM_VALIDATION_FAILED');
    expect((error.cause as Error).message).not.toContain('ada@example.com');
  });

  it('rejects a token with a different nonce', async () => {
    const signer = await createIdTokenSigner();
    const idToken = await signer.sign(baseClaims({ nonce: 'replayed-nonce' }));
    const fake = fakeFetch(() => jsonResponse({ id_token: idToken }));

    const error = await captureError(() =>
      createAdapter(fake, signer).exchangeAuthorizationCode(exchange),
    );

    expect(error.code).toBe('invalid_response');
    expect(error.message).toBe('google ID token nonce mismatch');
  });

  it('rejects a token that omits the expected nonce', async () => {
    const signer = await createIdTokenSigner();
    const claims = baseClaims();
    delete claims.nonce;
    const idToken = await signer.sign(claims);
    const fake = fakeFetch(() => jsonResponse({ id_token: idToken }));

    const error = await captureError(() =>
      createAdapter(fake, signer).exchangeAuthorizationCode(exchange),
    );

    expect(error.code).toBe('invalid_response');
  });

  it('rejects an expired token', async () => {
    const signer = await createIdTokenSigner();
    const idToken = await signer.sign(baseClaims({ exp: nowSeconds() - 600 }));
    const fake = fakeFetch(() => jsonResponse({ id_token: idToken }));

    const error = await captureError(() =>
      createAdapter(fake, signer).exchangeAuthorizationCode(exchange),
    );

    expect(error.code).toBe('invalid_response');
  });

  it('rejects a token signed by a key outside the JWKS', async () => {
    const verifierKeys = await createIdTokenSigner();
    const attackerKeys = await createIdTokenSigner();
    const forged = await attackerKeys.sign(baseClaims());
    const fake = fakeFetch(() => jsonResponse({ id_token: forged }));

    const error = await captureError(() =>
      createAdapter(fake, verifierKeys).exchangeAuthorizationCode(exchange),
    );

    expect(error.code).toBe('invalid_response');
    expect(error.message).not.toContain(forged);
  });

  it('returns an unverified email but refuses to call it verified', async () => {
    const signer = await createIdTokenSigner();
    const idToken = await signer.sign(baseClaims({ email_verified: false }));
    const fake = fakeFetch(() => jsonResponse({ id_token: idToken }));

    const profile = await createAdapter(fake, signer).exchangeAuthorizationCode(exchange);

    expect(profile.email).toBe('ada@example.com');
    expect(profile.emailVerified).toBe(false);

    const error = await captureError(async () => assertVerifiedEmail(profile));
    expect(error.code).toBe('email_unverified');
    expect(error.provider).toBe('google');
  });

  it('handles a missing email without inventing one', async () => {
    const signer = await createIdTokenSigner();
    const claims = baseClaims();
    delete claims.email;
    const idToken = await signer.sign(claims);
    const fake = fakeFetch(() => jsonResponse({ id_token: idToken }));

    const profile = await createAdapter(fake, signer).exchangeAuthorizationCode(exchange);

    expect(profile.email).toBeNull();
    expect(profile.emailVerified).toBe(false);
    expect(profile.displayName).toBe('Ada Lovelace');

    const error = await captureError(async () => assertVerifiedEmail(profile));
    expect(error.code).toBe('email_unverified');
  });

  it('falls back to the email local part when the provider sends no name', async () => {
    const signer = await createIdTokenSigner();
    const idToken = await signer.sign(baseClaims({ name: '   ' }));
    const fake = fakeFetch(() => jsonResponse({ id_token: idToken }));

    const profile = await createAdapter(fake, signer).exchangeAuthorizationCode(exchange);

    expect(profile.displayName).toBe('ada');
  });

  it('drops unsafe avatar URLs and malformed locales', async () => {
    const signer = await createIdTokenSigner();
    const idToken = await signer.sign(
      baseClaims({ picture: 'javascript:alert(1)', locale: 'not a locale' }),
    );
    const fake = fakeFetch(() => jsonResponse({ id_token: idToken }));

    const profile = await createAdapter(fake, signer).exchangeAuthorizationCode(exchange);

    expect(profile.avatarUrl).toBeNull();
    expect(profile.locale).toBeNull();
  });

  it('rejects a token without a usable subject', async () => {
    const signer = await createIdTokenSigner();
    const claims = baseClaims();
    delete claims.sub;
    const idToken = await signer.sign(claims);
    const fake = fakeFetch(() => jsonResponse({ id_token: idToken }));

    const error = await captureError(() =>
      createAdapter(fake, signer).exchangeAuthorizationCode(exchange),
    );

    expect(error.code).toBe('invalid_response');
    expect(error.message).toBe('google ID token is missing required claims');
  });
});
