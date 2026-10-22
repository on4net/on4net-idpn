import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ClientSecretService } from '../auth/client-secret.js';
import { registerFormBodyParser } from '../http/form-body.js';
import {
  authenticateClient,
  parseBasicAuthHeader,
  type ClientAuthRepository,
} from './client-auth.js';
import type { SigningKeyManager } from './keys.js';
import { hashRefreshToken, type RefreshTokenRepository } from './refresh-token.js';
import type { TokenDenyList } from './token-denylist.js';

export interface RevokeIntrospectOptions {
  issuer: string;
  clients: ClientAuthRepository;
  /** Keyed client-secret verifier; defaults to the process environment configuration. */
  clientSecrets?: ClientSecretService;
  refreshTokens: RefreshTokenRepository;
  keys: SigningKeyManager;
  /**
   * Session lookup. A refresh token whose session was revoked (global logout, admin action,
   * password change) is inactive even though its own row is untouched.
   */
  sessions?: { read(sid: string): Promise<unknown | null> };
  /**
   * Revoked access tokens. A JWT cannot be un-issued, so revoking one records its `jti` here
   * and introspection reports it inactive (docs/api.md 2.5).
   */
  denyList?: TokenDenyList;
  now?: () => Date;
}

interface TokenRequestBody {
  token?: string;
  token_type_hint?: string;
  client_id?: string;
  client_secret?: string;
}

const body = (request: FastifyRequest): TokenRequestBody =>
  (request.body ?? {}) as TokenRequestBody;

const noStore = (reply: FastifyReply): FastifyReply =>
  reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');

/**
 * `POST /oauth2/revoke` and `POST /oauth2/introspect` (docs/api.md 2.4/2.5).
 *
 * Revoking a refresh token revokes its whole family: the rotation chain then cannot be
 * resumed with a sibling token. Revocation always answers `200` so a caller cannot use it
 * to probe whether a token exists.
 */
export function registerRevokeIntrospectRoutes(
  app: FastifyInstance,
  options: RevokeIntrospectOptions,
): void {
  const now = options.now ?? (() => new Date());
  registerFormBodyParser(app);

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ clientId: string } | null> {
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
      ...(options.clientSecrets === undefined ? {} : { clientSecrets: options.clientSecrets }),
    });
    if (!auth.ok) {
      noStore(reply).code(401).send({ error: 'invalid_client' });
      return null;
    }
    return { clientId: auth.client.clientId };
  }

  app.post('/oauth2/revoke', async (request, reply) => {
    const client = await authenticate(request, reply);
    if (client === null) {
      return reply;
    }
    const payload = body(request);
    if (payload.token === undefined || payload.token === '') {
      return noStore(reply).code(400).send({ error: 'invalid_request' });
    }

    const record = await options.refreshTokens.findByHash(hashRefreshToken(payload.token));
    if (record !== null && record.clientId === client.clientId) {
      await options.refreshTokens.revokeFamily(record.familyId, now());
      return noStore(reply).code(200).send({});
    }

    // Not a refresh token this client owns: it may be an access token (RFC 7009 allows either).
    await denyAccessToken(payload.token, client.clientId);

    return noStore(reply).code(200).send({});
  });

  /**
   * Records the `jti` of one of our own access tokens so `/userinfo` and introspection stop
   * accepting it. A token that does not verify for this client, or belongs to another client,
   * is ignored — the answer stays `200` so revocation cannot be used to probe token validity.
   */
  async function denyAccessToken(token: string, clientId: string): Promise<void> {
    if (options.denyList === undefined) {
      return;
    }
    try {
      const claims = await options.keys.verify(token, {
        issuer: options.issuer,
        audience: clientId,
      });
      const jti = claims.jti;
      if (claims.token_use !== 'access' || typeof jti !== 'string' || jti === '') {
        return;
      }
      if (typeof claims.client_id !== 'string' || claims.client_id !== clientId) {
        return;
      }
      const expiresAt = claims.exp;
      if (typeof expiresAt !== 'number') {
        return;
      }
      await options.denyList.deny(jti, expiresAt);
    } catch {
      // Not our token or not a JWT: nothing to revoke.
    }
  }

  app.post('/oauth2/introspect', async (request, reply) => {
    const client = await authenticate(request, reply);
    if (client === null) {
      return reply;
    }
    const payload = body(request);
    if (payload.token === undefined || payload.token === '') {
      return noStore(reply).code(400).send({ error: 'invalid_request' });
    }

    const at = now();
    try {
      const claims = await options.keys.verify(payload.token, {
        issuer: options.issuer,
        audience: client.clientId,
      });
      const jti = claims.jti;
      const denied =
        options.denyList !== undefined &&
        typeof jti === 'string' &&
        (await options.denyList.isDenied(jti));
      if (denied) {
        return noStore(reply).send({ active: false });
      }
      return noStore(reply).send({
        active: true,
        ...claims,
        exp: claims.exp,
        iat: claims.iat,
      });
    } catch {
      // Not a JWT for this client; fall through to the refresh-token lookup.
    }

    const record = await options.refreshTokens.findByHash(hashRefreshToken(payload.token));
    const sessionAlive =
      record !== null &&
      (options.sessions === undefined ||
        (await options.sessions.read(record.sessionId)) !== null);
    const active =
      record !== null &&
      record.clientId === client.clientId &&
      record.revokedAt === null &&
      // A rotated token is spent: reporting it as active would let a client believe its old
      // token still works (and hides reuse).
      record.rotatedAt === null &&
      record.expiresAt > at &&
      sessionAlive;

    if (!active || record === null) {
      return noStore(reply).send({ active: false });
    }

    return noStore(reply).send({
      active: true,
      sub: record.userId,
      client_id: record.clientId,
      sid: record.sessionId,
      scope: record.scope.join(' '),
      exp: Math.floor(record.expiresAt.getTime() / 1000),
      token_type: 'refresh_token',
    });
  });
}
