import { describe, expect, it } from 'vitest';

import {
  FACEBOOK_AUTHORIZE_ENDPOINT,
  GOOGLE_AUTHORIZE_ENDPOINT,
  buildProviderAuthorizeUrl,
} from './provider-urls.js';

const input = {
  clientKey: 'client-key-app-a',
  redirectUri: 'https://auth.example.com/oauth2/social/app-a/google/callback',
  state: 'state-value',
  nonce: 'nonce-value',
  codeChallenge: 'challenge-value',
  scopes: ['openid', 'email', 'profile'],
};

describe('provider authorize URL', () => {
  it('sends Google the OIDC scopes, nonce and S256 challenge', () => {
    const url = new URL(buildProviderAuthorizeUrl({ ...input, provider: 'google' }));

    expect(url.origin + url.pathname).toBe(GOOGLE_AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get('client_id')).toBe('client-key-app-a');
    expect(url.searchParams.get('redirect_uri')).toBe(input.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('nonce')).toBe('nonce-value');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('access_type')).toBe('online');
  });

  it('translates Facebook scopes and omits the nonce it cannot verify', () => {
    const url = new URL(buildProviderAuthorizeUrl({ ...input, provider: 'facebook' }));

    expect(url.origin + url.pathname).toBe(FACEBOOK_AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get('scope')).toBe('email,public_profile');
    expect(url.searchParams.get('nonce')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('falls back to the documented minimum scopes', () => {
    const google = new URL(buildProviderAuthorizeUrl({ ...input, provider: 'google', scopes: [] }));
    expect(google.searchParams.get('scope')).toBe('openid email profile');

    const facebook = new URL(
      buildProviderAuthorizeUrl({ ...input, provider: 'facebook', scopes: [] }),
    );
    expect(facebook.searchParams.get('scope')).toBe('email,public_profile');
  });

  it('never puts a client secret in the URL', () => {
    const url = buildProviderAuthorizeUrl({ ...input, provider: 'google' });
    expect(url).not.toContain('secret');
  });
});
