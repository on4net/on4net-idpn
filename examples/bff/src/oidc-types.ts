/** Tokens exactly as the IdP returned them to the BFF. Never sent to the browser. */
export interface TokenSet {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export interface IdpClientConfig {
  /** Issuer origin, e.g. `https://idp.example.com`. */
  baseUrl: string;
  clientId: string;
  /** Confidential client secret; `client_secret_basic` at the token endpoint. */
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface AuthorizeRequestParams {
  state: string;
  nonce: string;
  codeChallenge: string;
  uiLocales?: string;
  loginHint?: string;
}

export interface ExchangeCodeParams {
  code: string;
  codeVerifier: string;
}

export type OidcResult<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };
