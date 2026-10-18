/** Claims supported by this IdP (docs/api.md 2.1). */
export const SUPPORTED_CLAIMS = [
  'sub',
  'iss',
  'aud',
  'exp',
  'iat',
  'auth_time',
  'nonce',
  'acr',
  'amr',
  'sid',
  'tenant_id',
  'preferred_username',
  'email',
  'email_verified',
  'name',
  'locale',
  'login_context',
] as const;

export const SUPPORTED_SCOPES = [
  'openid',
  'profile',
  'email',
  'phone',
  'offline_access',
  'idp.admin',
  'idp.client-admin',
  'idp.client-locale',
  'idp.client-context',
] as const;

export interface DiscoveryOptions {
  /** Public issuer, e.g. https://auth.example.com (no trailing slash). */
  issuer: string;
}

export interface OpenIdConfiguration {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  end_session_endpoint: string;
  revocation_endpoint: string;
  introspection_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  scopes_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  claims_supported: string[];
  backchannel_logout_supported: boolean;
  backchannel_logout_session_supported: boolean;
}

export const DISCOVERY_CACHE_CONTROL = 'public, max-age=3600';
export const JWKS_CACHE_CONTROL = 'public, max-age=300';

/** Builds `/.well-known/openid-configuration` exactly as documented in docs/api.md 2.1. */
export function buildOpenIdConfiguration({ issuer }: DiscoveryOptions): OpenIdConfiguration {
  const base = issuer.replace(/\/+$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth2/authorize`,
    token_endpoint: `${base}/oauth2/token`,
    userinfo_endpoint: `${base}/oauth2/userinfo`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    end_session_endpoint: `${base}/oauth2/logout`,
    revocation_endpoint: `${base}/oauth2/revoke`,
    introspection_endpoint: `${base}/oauth2/introspect`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['ES256'],
    scopes_supported: [...SUPPORTED_SCOPES],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: [...SUPPORTED_CLAIMS],
    backchannel_logout_supported: true,
    backchannel_logout_session_supported: true,
  };
}
