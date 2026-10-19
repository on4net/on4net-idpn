import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { registerFormBodyParser } from '../http/form-body.js';
import type { IdpSession } from '../session/types.js';
import {
  exchangeAuthorizationCode,
  type AuthorizationCodeRecord,
  type AuthorizationCodeRepository,
} from './authorization-code.js';
import {
  authenticateClient,
  parseBasicAuthHeader,
  type AuthenticatedClient,
  type ClientAuthRepository,
} from './client-auth.js';
import type { SigningKeyManager } from './keys.js';
import {
  type LoginContextAccessDecision,
  type LoginContextAccessSource,
} from './login-context-access.js';
import { oauthError, type OAuthError } from './oauth-error.js';
import {
  issueRefreshToken,
  rotateRefreshToken,
  type RefreshTokenRepository,
} from './refresh-token.js';
import {
  accessClaimsFor,
  buildAccessTokenClaims,
  buildIdTokenClaims,
  ID_TOKEN_TTL_SECONDS,
  type TokenProfile,
  type TokenResponse,
  type UserProfileRepository,
} from './token-claims.js';
import type { EffectiveAccess, EffectiveAccessSource } from './effective-access.js';

export interface TokenRouteOptions {
  issuer: string;
  clients: ClientAuthRepository;
  codes: AuthorizationCodeRepository;
  refreshTokens: RefreshTokenRepository;
  users: UserProfileRepository;
  keys: SigningKeyManager;
  /** Optional session lookup so revocation invalidates refresh grants immediately. */
  sessions?: {
    read(sid: string): Promise<IdpSession | null>;
    /** Records the context a session now acts in after an audited context switch. */
    rebindContext?(sid: string, loginContext: string): Promise<IdpSession | null>;
  };
  /**
   * Eligibility for the `idp.client-admin` scope. The scope is never issued to a user who
   * holds no `idp:client-*` permission for the app, even if an old code or refresh token
   * still carries it.
   */
  isClientAdminEligible?: (userId: string, clientId: string) => Promise<boolean>;
  /** Effective roles/permissions/membership claim source (docs/domain-model.md 3.2). */
  access?: EffectiveAccessSource;
  /**
   * Login-context state check for context-bound codes and refresh tokens
   * (docs/login-contexts.md 4.1, 6). When a code/token carries `login_context`, the token
   * endpoint must verify that the context is still active and that the user's membership
   * for it is still active; otherwise no token is issued. A missing source fails closed.
   */
  contextAccess?: LoginContextAccessSource;
  now?: () => Date;
}

const CLIENT_ADMIN_SCOPE = 'idp.client-admin';

interface TokenRequestBody {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  scope?: string;
}

const body = (request: FastifyRequest): TokenRequestBody =>
  (request.body ?? {}) as TokenRequestBody;

const noStore = (reply: FastifyReply): FastifyReply =>
  reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');

const tokenError = (reply: FastifyReply, error: OAuthError, status = 400): FastifyReply =>
  noStore(reply).code(status).send(error);

const tokenSuccess = (reply: FastifyReply, payload: TokenResponse): FastifyReply =>
  noStore(reply).send(payload);

/**
 * `POST /oauth2/token` — authorization_code, refresh_token and client_credentials grants
 * (docs/api.md 2.2). Every failure is returned as a standard OAuth error body; internal
 * reasons never reach the caller.
 */
export function registerTokenRoute(app: FastifyInstance, options: TokenRouteOptions): void {
  const now = options.now ?? (() => new Date());
  registerFormBodyParser(app);

  app.post('/oauth2/token', async (request, reply) => {
    const payload = body(request);
    const basic = parseBasicAuthHeader(request.headers.authorization);
    const clientId = basic?.clientId ?? payload.client_id;
    const clientSecret = basic?.clientSecret ?? payload.client_secret;
    const method =
      basic !== null
        ? 'client_secret_basic'
        : payload.client_secret !== undefined
          ? 'client_secret_post'
          : 'none';

    const auth = await authenticateClient(options.clients, {
      ...(clientId === undefined ? {} : { clientId }),
      ...(clientSecret === undefined ? {} : { clientSecret }),
      method,
    });

    if (!auth.ok) {
      // RFC 6749 5.2: a failed client authentication is `invalid_client` with HTTP 401. The
      // response is identical for unknown clients and wrong secrets (no enumeration).
      if (basic !== null) {
        reply.header('WWW-Authenticate', 'Basic realm="token"');
      }
      return tokenError(reply, oauthError('invalid_client', 'client authentication failed'), 401);
    }

    switch (payload.grant_type) {
      case 'authorization_code':
        return authorizationCodeGrant(reply, payload, auth.client, options, now());
      case 'refresh_token':
        return refreshTokenGrant(reply, payload, auth.client, options, now());
      case 'client_credentials':
        return clientCredentialsGrant(reply, payload, auth.client, options, now());
      default:
        return tokenError(reply, oauthError('unsupported_grant_type'));
    }
  });
}

async function authorizationCodeGrant(
  reply: FastifyReply,
  payload: TokenRequestBody,
  client: AuthenticatedClient,
  options: TokenRouteOptions,
  at: Date,
): Promise<FastifyReply> {
  if (payload.code === undefined || payload.redirect_uri === undefined) {
    return tokenError(reply, oauthError('invalid_request', 'code and redirect_uri are required'));
  }

  const exchange = await exchangeAuthorizationCode(options.codes, {
    code: payload.code,
    clientId: client.clientId,
    redirectUri: payload.redirect_uri,
    ...(payload.code_verifier === undefined ? {} : { codeVerifier: payload.code_verifier }),
    now: at,
  });

  if (!exchange.ok) {
    return tokenError(reply, oauthError('invalid_grant', 'authorization code is not valid'));
  }

  const profile = await options.users.findProfile(exchange.record.userId);
  if (profile === null) {
    return tokenError(reply, oauthError('invalid_grant', 'unknown subject'));
  }

  // The code is consumed above, so a context that was disabled or a membership that was
  // suspended between `/authorize` and this call burns the code instead of yielding a token.
  if (exchange.record.loginContext !== undefined) {
    const decision = await resolveContextAccess(
      options,
      profile.id,
      client.clientId,
      exchange.record.loginContext,
    );
    if (!decision.ok) {
      return tokenError(reply, oauthError('access_denied', 'login context is not available'));
    }
  }

  if (
    exchange.record.scope.includes(CLIENT_ADMIN_SCOPE) &&
    options.isClientAdminEligible !== undefined &&
    !(await options.isClientAdminEligible(profile.id, client.clientId))
  ) {
    return tokenError(
      reply,
      oauthError('access_denied', 'client administration permission is required'),
    );
  }

  const issuedAt = Math.floor(at.getTime() / 1000);
  const access = await resolveAccess(
    options,
    profile.id,
    client.clientId,
    exchange.record.loginContext,
  );
  const accessToken = await signAccessToken(
    options,
    client,
    profile,
    exchange.record,
    issuedAt,
    at,
    access,
  );
  const idToken = await signIdToken(options, client, profile, exchange.record, issuedAt);

  const response: TokenResponse = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: client.accessTokenTtl,
    id_token: idToken,
    scope: exchange.record.scope.join(' '),
  };

  if (exchange.record.scope.includes('offline_access')) {
    const refresh = await issueRefreshToken(options.refreshTokens, {
      clientId: client.clientId,
      userId: profile.id,
      sessionId: exchange.record.sessionId,
      scope: exchange.record.scope,
      ttlSeconds: client.refreshTokenTtl,
      ...(exchange.record.loginContext === undefined
        ? {}
        : { loginContext: exchange.record.loginContext }),
      now: at,
    });
    response.refresh_token = refresh.token;
  }

  return tokenSuccess(reply, response);
}

async function refreshTokenGrant(
  reply: FastifyReply,
  payload: TokenRequestBody,
  client: AuthenticatedClient,
  options: TokenRouteOptions,
  at: Date,
): Promise<FastifyReply> {
  if (payload.refresh_token === undefined || payload.refresh_token === '') {
    return tokenError(reply, oauthError('invalid_request', 'refresh_token is required'));
  }

  const rotation = await rotateRefreshToken(options.refreshTokens, {
    token: payload.refresh_token,
    clientId: client.clientId,
    ttlSeconds: client.refreshTokenTtl,
    now: at,
  });

  if (!rotation.ok) {
    // Reuse revokes the whole family inside rotateRefreshToken; the client only sees invalid_grant.
    return tokenError(reply, oauthError('invalid_grant', 'refresh token is not valid'));
  }

  const profile = await options.users.findProfile(rotation.record.userId);
  if (profile === null) {
    return tokenError(reply, oauthError('invalid_grant', 'unknown subject'));
  }

  // A refresh token stays bound to the context it was issued for: the request cannot ask
  // for another one, and the context/membership is re-evaluated on every rotation
  // (docs/domain-model.md 2.6.2). A revoked context burns the family.
  if (rotation.record.loginContext !== undefined) {
    const decision = await resolveContextAccess(
      options,
      profile.id,
      client.clientId,
      rotation.record.loginContext,
    );
    if (!decision.ok) {
      await options.refreshTokens.revokeFamily(rotation.record.familyId, at);
      return tokenError(reply, oauthError('invalid_grant', 'refresh token is not valid'));
    }
  }

  if (
    rotation.record.scope.includes(CLIENT_ADMIN_SCOPE) &&
    options.isClientAdminEligible !== undefined &&
    !(await options.isClientAdminEligible(profile.id, client.clientId))
  ) {
    return tokenError(
      reply,
      oauthError('access_denied', 'client administration permission is required'),
    );
  }

  const session =
    options.sessions === undefined ? null : await options.sessions.read(rotation.record.sessionId);
  if (options.sessions !== undefined && session === null) {
    return tokenError(reply, oauthError('invalid_grant', 'session is no longer valid'));
  }

  const issuedAt = Math.floor(at.getTime() / 1000);
  const access = await resolveAccess(
    options,
    profile.id,
    client.clientId,
    rotation.record.loginContext,
  );
  const accessToken = await options.keys.signAccessToken(
    {
      iss: options.issuer,
      sub: profile.id,
      aud: client.clientId,
      client_id: client.clientId,
      iat: issuedAt,
      exp: issuedAt + client.accessTokenTtl,
      auth_time: Math.floor(new Date(session?.authTime ?? at.toISOString()).getTime() / 1000),
      acr: session?.acr ?? 'urn:on4net:acr:pwd',
      amr: session?.amr ?? ['pwd'],
      sid: rotation.record.sessionId,
      jti: randomUUID(),
      scope: rotation.record.scope.join(' '),
      tenant_id: profile.tenantId,
      ...(rotation.record.loginContext === undefined
        ? {}
        : { login_context: rotation.record.loginContext }),
      ...accessClaimsFor(access),
    },
    {
      issuer: options.issuer,
      audience: client.clientId,
      subject: profile.id,
      expiresInSeconds: client.accessTokenTtl,
    },
  );

  const next = await issueRefreshToken(options.refreshTokens, {
    clientId: client.clientId,
    userId: rotation.record.userId,
    sessionId: rotation.record.sessionId,
    scope: rotation.record.scope,
    ttlSeconds: client.refreshTokenTtl,
    familyId: rotation.record.familyId,
    // Without this the successor would silently lose its context binding and the next
    // refresh would issue an unnarrowed token.
    ...(rotation.record.loginContext === undefined
      ? {}
      : { loginContext: rotation.record.loginContext }),
    now: at,
  });

  return tokenSuccess(reply, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: client.accessTokenTtl,
    refresh_token: next.token,
    scope: rotation.record.scope.join(' '),
  });
}

async function clientCredentialsGrant(
  reply: FastifyReply,
  payload: TokenRequestBody,
  client: AuthenticatedClient,
  options: TokenRouteOptions,
  at: Date,
): Promise<FastifyReply> {
  const requested = (payload.scope ?? '').split(/\s+/).filter((scope) => scope !== '');
  if (requested.length === 0) {
    return tokenError(reply, oauthError('invalid_scope'));
  }
  const invalid = requested.find(
    (scope) => !client.scopes.includes(scope) || scope === 'openid' || scope === 'offline_access',
  );
  if (invalid !== undefined) {
    return tokenError(reply, oauthError('invalid_scope', `scope "${invalid}" is not allowed`));
  }

  const issuedAt = Math.floor(at.getTime() / 1000);
  const accessToken = await options.keys.signAccessToken(
    {
      iss: options.issuer,
      sub: client.clientId,
      aud: client.clientId,
      client_id: client.clientId,
      iat: issuedAt,
      exp: issuedAt + client.accessTokenTtl,
      jti: randomUUID(),
      scope: requested.join(' '),
    },
    {
      issuer: options.issuer,
      audience: client.clientId,
      subject: client.clientId,
      expiresInSeconds: client.accessTokenTtl,
    },
  );

  return tokenSuccess(reply, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: client.accessTokenTtl,
    scope: requested.join(' '),
  });
}

/**
 * Fails closed when a context-bound token is presented but no context source is wired: an
 * operator misconfiguration must never turn a narrowed grant into an unnarrowed one.
 */
async function resolveContextAccess(
  options: TokenRouteOptions,
  userId: string,
  clientId: string,
  loginContext: string,
): Promise<LoginContextAccessDecision> {
  if (options.contextAccess === undefined) {
    return { ok: false, reason: 'context_not_found' };
  }
  return options.contextAccess.resolve({ userId, clientId, loginContext });
}

async function resolveAccess(
  options: TokenRouteOptions,
  userId: string,
  clientId: string,
  loginContext?: string,
): Promise<EffectiveAccess | undefined> {
  if (options.access === undefined) {
    return undefined;
  }
  return options.access.resolve({
    userId,
    clientId,
    ...(loginContext === undefined ? {} : { loginContext }),
  });
}

function signAccessToken(
  options: TokenRouteOptions,
  client: AuthenticatedClient,
  profile: TokenProfile,
  code: AuthorizationCodeRecord,
  issuedAt: number,
  at: Date,
  access?: EffectiveAccess,
): Promise<string> {
  void at;
  return options.keys.signAccessToken(
    buildAccessTokenClaims({
      issuer: options.issuer,
      clientId: client.clientId,
      profile,
      code,
      expiresInSeconds: client.accessTokenTtl,
      issuedAt,
      jti: randomUUID(),
      ...(access === undefined ? {} : { access }),
    }),
    {
      issuer: options.issuer,
      audience: client.clientId,
      subject: profile.id,
      expiresInSeconds: client.accessTokenTtl,
    },
  );
}

function signIdToken(
  options: TokenRouteOptions,
  client: AuthenticatedClient,
  profile: TokenProfile,
  code: AuthorizationCodeRecord,
  issuedAt: number,
): Promise<string> {
  return options.keys.signAccessToken(
    buildIdTokenClaims({
      issuer: options.issuer,
      clientId: client.clientId,
      profile,
      code,
      expiresInSeconds: ID_TOKEN_TTL_SECONDS,
      issuedAt,
      jti: randomUUID(),
    }),
    {
      issuer: options.issuer,
      audience: client.clientId,
      subject: profile.id,
      expiresInSeconds: ID_TOKEN_TTL_SECONDS,
    },
  );
}
