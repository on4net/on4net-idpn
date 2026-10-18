import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { registerFormBodyParser } from '../http/form-body.js';
import {
  authenticateClient,
  parseBasicAuthHeader,
  type ClientAuthRepository,
} from './client-auth.js';
import type { SigningKeyManager } from './keys.js';
import { hashRefreshToken, type RefreshTokenRepository } from './refresh-token.js';

export interface RevokeIntrospectOptions {
  issuer: string;
  clients: ClientAuthRepository;
  refreshTokens: RefreshTokenRepository;
  keys: SigningKeyManager;
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
    }

    return noStore(reply).code(200).send({});
  });

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
    const active =
      record !== null &&
      record.clientId === client.clientId &&
      record.revokedAt === null &&
      record.expiresAt > at;

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
