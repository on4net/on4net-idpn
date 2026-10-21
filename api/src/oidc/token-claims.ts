import type { AuthorizationCodeRecord } from './authorization-code.js';
import type { EffectiveAccess } from './effective-access.js';

export const ID_TOKEN_TTL_SECONDS = 300;

/**
 * Above this size the roles/permissions claim set is left out of the access token and the
 * client is told to read it from `/oauth2/userinfo` (docs/domain-model.md 3.2).
 */
export const ACCESS_CLAIM_SIZE_LIMIT = 2048;

export function accessClaimsFor(access: EffectiveAccess | undefined): Record<string, unknown> {
  if (access === undefined) {
    return {};
  }
  const claims: Record<string, unknown> = {
    roles: access.roles,
    permissions: access.permissions,
    ...(access.membership === null ? {} : { membership: access.membership }),
  };
  if (Buffer.byteLength(JSON.stringify(claims), 'utf8') > ACCESS_CLAIM_SIZE_LIMIT) {
    return { permissions_source: 'userinfo' };
  }
  return claims;
}

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
  /** Effective roles, permissions and membership for this client. */
  access?: EffectiveAccess;
}

/** Access token claims (docs/auth-flows.md 4.2). */
export function buildAccessTokenClaims(input: AccessTokenClaimsInput): Record<string, unknown> {
  return {
    iss: input.issuer,
    sub: input.profile.id,
    aud: input.clientId,
    client_id: input.clientId,
    // Resource servers (including `/oauth2/userinfo`) must be able to tell an access token
    // from an ID token; ID tokens carry no `token_use`.
    token_use: 'access',
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
    ...accessClaimsFor(input.access),
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
