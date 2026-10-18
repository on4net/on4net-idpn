import type { AuthorizationCodeRecord } from './authorization-code.js';

export const ID_TOKEN_TTL_SECONDS = 300;

export interface TokenProfile {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  locale: string;
  tenantId: string;
}

export interface UserProfileRepository {
  findProfile(userId: string): Promise<TokenProfile | null>;
}

export interface AccessTokenClaimsInput {
  issuer: string;
  clientId: string;
  profile: TokenProfile;
  code: AuthorizationCodeRecord;
  expiresInSeconds: number;
  issuedAt: number;
  jti: string;
}

/** Access token claims (docs/auth-flows.md 4.2). Roles/permissions arrive with RBAC. */
export function buildAccessTokenClaims(input: AccessTokenClaimsInput): Record<string, unknown> {
  return {
    iss: input.issuer,
    sub: input.profile.id,
    aud: input.clientId,
    client_id: input.clientId,
    iat: input.issuedAt,
    exp: input.issuedAt + input.expiresInSeconds,
    auth_time: Math.floor(input.code.authTime.getTime() / 1000),
    acr: input.code.acr,
    amr: input.code.amr,
    sid: input.code.sessionId,
    jti: input.jti,
    scope: input.code.scope.join(' '),
    tenant_id: input.profile.tenantId,
    ...(input.code.loginContext === undefined ? {} : { login_context: input.code.loginContext }),
  };
}

/** ID token claims (docs/domain-model.md 3.6): identity only, no roles. */
export function buildIdTokenClaims(input: AccessTokenClaimsInput): Record<string, unknown> {
  return {
    iss: input.issuer,
    sub: input.profile.id,
    aud: input.clientId,
    iat: input.issuedAt,
    exp: input.issuedAt + ID_TOKEN_TTL_SECONDS,
    auth_time: Math.floor(input.code.authTime.getTime() / 1000),
    nonce: input.code.nonce ?? undefined,
    acr: input.code.acr,
    amr: input.code.amr,
    sid: input.code.sessionId,
    preferred_username: input.profile.username,
    email: input.profile.email,
    email_verified: input.profile.emailVerified,
    name: input.profile.displayName,
    locale: input.profile.locale,
    tenant_id: input.profile.tenantId,
    ...(input.code.loginContext === undefined ? {} : { login_context: input.code.loginContext }),
  };
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  id_token?: string;
  refresh_token?: string;
  scope: string;
}

export const tokenResponseHeaders = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const;
