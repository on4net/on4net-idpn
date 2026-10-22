import { DEFAULT_SOCIAL_SCOPES } from '../admin/social-providers/social-provider-types.js';
import type { SocialProviderId } from './types.js';

/** Provider authorization endpoints. The pinned Facebook Graph version matches the adapter. */
export const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const FACEBOOK_AUTHORIZE_ENDPOINT = 'https://www.facebook.com/v21.0/dialog/oauth';

export interface ProviderAuthorizeUrlInput {
  provider: SocialProviderId;
  /** Per-app provider client id (`ClientSocialProvider.client_key`). */
  clientKey: string;
  /** Exact callback registered for this app and provider. */
  redirectUri: string;
  state: string;
  nonce: string | null;
  codeChallenge: string;
  /** Scopes configured for this app's provider; empty falls back to the documented minimum. */
  scopes: string[];
}

/**
 * Builds the provider authorization URL (`docs/auth-flows.md` 9.2/9.4).
 *
 * Only the app's own `client_key` is used; the secret never leaves the server. PKCE (`S256`)
 * is requested for both providers, and Google additionally receives the login nonce.
 */
export function buildProviderAuthorizeUrl(input: ProviderAuthorizeUrlInput): string {
  const scopes = input.scopes.length === 0 ? [...DEFAULT_SOCIAL_SCOPES] : input.scopes;
  const url =
    input.provider === 'google'
      ? new URL(GOOGLE_AUTHORIZE_ENDPOINT)
      : new URL(FACEBOOK_AUTHORIZE_ENDPOINT);

  url.searchParams.set('client_id', input.clientKey);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  if (input.provider === 'google') {
    url.searchParams.set('scope', scopes.join(' '));
    if (input.nonce !== null) {
      url.searchParams.set('nonce', input.nonce);
    }
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
  } else {
    url.searchParams.set('scope', facebookScopes(scopes).join(','));
  }

  return url.toString();
}

/**
 * Facebook rejects the OIDC scope names: `profile` is `public_profile` and `openid` does not
 * exist there. Unknown scopes are passed through unchanged so an app can request extras.
 */
function facebookScopes(scopes: string[]): string[] {
  const mapped = new Set<string>();
  for (const scope of scopes) {
    if (scope === 'openid') {
      continue;
    }
    mapped.add(scope === 'profile' ? 'public_profile' : scope);
  }
  if (mapped.size === 0) {
    mapped.add('public_profile');
    mapped.add('email');
  }
  return [...mapped];
}
