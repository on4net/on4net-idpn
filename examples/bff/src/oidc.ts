import type {
  AuthorizeRequestParams,
  ExchangeCodeParams,
  IdpClientConfig,
  OidcResult,
  TokenSet,
} from './oidc-types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const trimBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

export const endpoints = (config: IdpClientConfig) => ({
  authorize: `${trimBase(config.baseUrl)}/oauth2/authorize`,
  token: `${trimBase(config.baseUrl)}/oauth2/token`,
  userinfo: `${trimBase(config.baseUrl)}/oauth2/userinfo`,
  revoke: `${trimBase(config.baseUrl)}/oauth2/revoke`,
});

/** Builds the authorization URL with PKCE, `state` and `nonce` (docs/auth-flows.md 2.1). */
export function buildAuthorizeUrl(config: IdpClientConfig, params: AuthorizeRequestParams): string {
  const url = new URL(endpoints(config).authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (params.uiLocales !== undefined) {
    url.searchParams.set('ui_locales', params.uiLocales);
  }
  if (params.loginHint !== undefined) {
    url.searchParams.set('login_hint', params.loginHint);
  }
  return url.toString();
}

function basicAuth(config: IdpClientConfig): string {
  const raw = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

function toTokenSet(payload: unknown): TokenSet | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const accessToken = record['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    return null;
  }
  return {
    access_token: accessToken,
    token_type: typeof record['token_type'] === 'string' ? record['token_type'] : 'Bearer',
    expires_in: typeof record['expires_in'] === 'number' ? record['expires_in'] : 300,
    ...(typeof record['refresh_token'] === 'string'
      ? { refresh_token: record['refresh_token'] }
      : {}),
    ...(typeof record['id_token'] === 'string' ? { id_token: record['id_token'] } : {}),
    ...(typeof record['scope'] === 'string' ? { scope: record['scope'] } : {}),
  };
}

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  body: Record<string, string>,
  headers: Record<string, string>,
): Promise<OidcResult<TokenSet>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...headers,
      },
      body: new URLSearchParams(body).toString(),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'network_error' };
  }

  const payload: unknown = await response.json().catch((): unknown => null);

  if (!response.ok) {
    const code =
      payload !== null &&
      typeof payload === 'object' &&
      typeof (payload as { error?: unknown }).error === 'string'
        ? String((payload as { error: string }).error)
        : `http_${response.status}`;
    return { ok: false, error: code, status: response.status };
  }

  const tokens = toTokenSet(payload);
  return tokens === null
    ? { ok: false, error: 'invalid_token_response', status: response.status }
    : { ok: true, value: tokens };
}

/** Redeems an authorization code (`grant_type=authorization_code`) with the PKCE verifier. */
export function exchangeCode(
  fetchImpl: FetchLike,
  config: IdpClientConfig,
  params: ExchangeCodeParams,
): Promise<OidcResult<TokenSet>> {
  return postForm(
    fetchImpl,
    endpoints(config).token,
    {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: config.redirectUri,
      code_verifier: params.codeVerifier,
    },
    { Authorization: basicAuth(config) },
  );
}

/** Rotates the refresh token (`grant_type=refresh_token`). */
export function refreshTokens(
  fetchImpl: FetchLike,
  config: IdpClientConfig,
  refreshToken: string,
): Promise<OidcResult<TokenSet>> {
  return postForm(
    fetchImpl,
    endpoints(config).token,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    { Authorization: basicAuth(config) },
  );
}

/** Revokes a token at the IdP; failures are reported but never block local logout. */
export async function revokeToken(
  fetchImpl: FetchLike,
  config: IdpClientConfig,
  token: string,
): Promise<boolean> {
  try {
    const response = await fetchImpl(endpoints(config).revoke, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuth(config),
      },
      body: new URLSearchParams({ token, token_type_hint: 'refresh_token' }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type UserInfoResult =
  { ok: true; claims: Record<string, unknown> } | { ok: false; status: number };

/** Calls the userinfo endpoint with the access token (server-to-server only). */
export async function fetchUserInfo(
  fetchImpl: FetchLike,
  config: IdpClientConfig,
  accessToken: string,
): Promise<UserInfoResult> {
  let response: Response;
  try {
    response = await fetchImpl(endpoints(config).userinfo, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
  } catch {
    return { ok: false, status: 0 };
  }
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  const claims: unknown = await response.json().catch((): unknown => null);
  return claims !== null && typeof claims === 'object'
    ? { ok: true, claims: claims as Record<string, unknown> }
    : { ok: false, status: response.status };
}
