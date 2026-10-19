import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { decodeJwt } from 'jose';

import { sanitizeAuditMetadata, type AuditEventInput } from '../audit/sanitize.js';
import { registerFormBodyParser } from '../http/form-body.js';
import { clearSessionCookie, readSessionId, type SessionCookieOptions } from '../session/cookie.js';
import type { IdpSession, RevokeReason } from '../session/types.js';
import type {
  BackchannelLogoutNotifyInput,
  BackchannelLogoutParticipant,
} from './backchannel-logout.js';
import type { ClientRepository, OAuthClient } from './client-repository.js';
import type { SigningKeyManager } from './keys.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Persistence required by logout. Participants are derived from the database because a
 * session is shared by every client that obtained a code or refresh token for it.
 */
export interface LogoutRevocationStore {
  findParticipants(sessionId: string): Promise<BackchannelLogoutParticipant[]>;
  revokeSession(sessionId: string, revokedAt: Date, reason: RevokeReason): Promise<boolean>;
  revokeRefreshTokens(sessionId: string, revokedAt: Date): Promise<number>;
}

export interface LogoutRouteOptions {
  issuer: string;
  keys: SigningKeyManager;
  clients: ClientRepository;
  sessions: {
    read(sid: string): Promise<IdpSession | null>;
    revoke(sid: string, reason: RevokeReason): Promise<boolean>;
  };
  revocations: LogoutRevocationStore;
  /** Back-channel dispatcher; delivery never rejects (retry + queue are internal). */
  backchannel: { notify(input: BackchannelLogoutNotifyInput): Promise<unknown> };
  audit: { record(event: AuditEventInput): Promise<void> };
  cookie: Pick<SessionCookieOptions, 'secure' | 'path' | 'domain'>;
  now?: () => Date;
}

type Params = Record<string, unknown>;

const noStore = (reply: FastifyReply): FastifyReply => reply.header('Cache-Control', 'no-store');

const invalidRequest = (reply: FastifyReply, description: string): FastifyReply =>
  noStore(reply).code(400).send({ error: 'invalid_request', error_description: description });

function readParam(query: Params, body: Params, name: string): string | undefined {
  const value = body[name] ?? query[name];
  return typeof value === 'string' ? value : undefined;
}

/** `aud` must identify exactly one client; an array of audiences is ambiguous for logout. */
function singleAudience(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') {
    return value;
  }
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}

function isAllowedRedirect(client: OAuthClient, requested: string): boolean {
  if (requested.includes('*')) {
    return false;
  }
  return (client.postLogoutRedirectUris ?? []).some(
    (registered) => !registered.includes('*') && registered === requested,
  );
}

/**
 * `GET|POST /oauth2/logout` — RP-initiated logout (docs/auth-flows.md 6.2, docs/api.md 2).
 *
 * - the `id_token_hint` is signature/issuer/audience validated; a bad hint is a plain `400`
 *   and is never used to build a redirect;
 * - `post_logout_redirect_uri` must exactly match a registered value (no wildcards);
 * - the IdP session is revoked in Redis and PostgreSQL, the session's refresh tokens are
 *   revoked and the session cookie is cleared;
 * - participating clients are notified out of band, so a failing client cannot fail or
 *   delay the user's logout.
 */
export function registerLogoutRoute(app: FastifyInstance, options: LogoutRouteOptions): void {
  const now = options.now ?? (() => new Date());
  // IdPs receive form-encoded POSTs from RP back ends; JSON stays supported for tests.
  registerFormBodyParser(app);

  async function handler(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const query = (request.query ?? {}) as Params;
    const body = (request.body ?? {}) as Params;
    const idTokenHint = readParam(query, body, 'id_token_hint');
    const requestedRedirect = readParam(query, body, 'post_logout_redirect_uri');
    const state = readParam(query, body, 'state');
    const requestedClientId = readParam(query, body, 'client_id');

    let client: OAuthClient | undefined;
    let sid: string | undefined;
    let sub: string | undefined;

    if (idTokenHint !== undefined && idTokenHint !== '') {
      let audience: string | undefined;
      try {
        audience = singleAudience(decodeJwt(idTokenHint).aud);
      } catch {
        return invalidRequest(reply, 'id_token_hint is not a valid token');
      }
      if (audience === undefined) {
        return invalidRequest(reply, 'id_token_hint must have a single audience');
      }
      if (requestedClientId !== undefined && requestedClientId !== audience) {
        return invalidRequest(reply, 'id_token_hint does not belong to client_id');
      }

      const found = await options.clients.findByClientId(audience);
      if (found === null || found.status !== 'active') {
        return invalidRequest(reply, 'id_token_hint does not belong to an active client');
      }

      let payload: Record<string, unknown>;
      try {
        payload = await options.keys.verify(idTokenHint, {
          issuer: options.issuer,
          audience,
          currentDate: now(),
        });
      } catch {
        return invalidRequest(reply, 'id_token_hint is not valid');
      }

      if (typeof payload['sid'] !== 'string' || !UUID_PATTERN.test(payload['sid'])) {
        return invalidRequest(reply, 'id_token_hint has no valid session id');
      }

      client = found;
      sid = payload['sid'];
      if (typeof payload['sub'] === 'string' && payload['sub'] !== '') {
        sub = payload['sub'];
      }
    } else if (requestedRedirect !== undefined) {
      // Without a verified hint there is no trustworthy client to validate the URI against.
      return invalidRequest(reply, 'id_token_hint is required to use post_logout_redirect_uri');
    }

    if (requestedRedirect !== undefined) {
      if (requestedRedirect === '' || client === undefined) {
        return invalidRequest(reply, 'post_logout_redirect_uri is invalid');
      }
      if (!isAllowedRedirect(client, requestedRedirect)) {
        return invalidRequest(reply, 'post_logout_redirect_uri is not registered');
      }
    }

    const cookieSid = readSessionId(request.headers.cookie);
    if (sid === undefined) {
      // No hint: fall back to the cookie session. An opaque/unknown id is simply ignored.
      if (cookieSid === null || !UUID_PATTERN.test(cookieSid)) {
        return noStore(reply).code(204).send();
      }
      sid = cookieSid;
    }

    const session = await options.sessions.read(sid);
    if (session !== null && sub !== undefined && session.userId !== sub) {
      return invalidRequest(reply, 'id_token_hint does not match the session subject');
    }
    const effectiveSub = sub ?? session?.userId;

    const participants = await options.revocations.findParticipants(sid);
    const at = now();
    const redisRevoked = await options.sessions.revoke(sid, 'logout');
    const databaseRevoked = await options.revocations.revokeSession(sid, at, 'logout');
    const revokedRefreshTokens = await options.revocations.revokeRefreshTokens(sid, at);

    const actorId = session?.userId ?? sub;
    const metadata = {
      sid,
      participants: participants.length,
      backchannel_clients: participants.filter(
        (participant) =>
          participant.backchannelLogoutUri !== null && participant.backchannelLogoutUri !== '',
      ).length,
      revoked_refresh_tokens: revokedRefreshTokens,
      redis_revoked: redisRevoked,
      database_revoked: databaseRevoked,
    };

    await options.audit.record({
      actorType: actorId === undefined ? 'anonymous' : 'user',
      actorId: actorId ?? null,
      action: 'session.logout',
      targetType: 'session',
      targetId: sid,
      clientId: client?.clientId ?? session?.clientId ?? null,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'success',
      metadata: sanitizeAuditMetadata(metadata),
    });

    if (actorId !== undefined) {
      await options.audit.record({
        actorType: 'user',
        actorId,
        action: 'user.logout.global',
        targetType: 'user',
        targetId: actorId,
        clientId: client?.clientId ?? null,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        result: 'success',
        metadata: sanitizeAuditMetadata({ sid, participants: participants.length }),
      });
    }

    if (participants.length > 0) {
      // Fire and forget: revocation already happened and the dispatcher never rejects.
      const delivery = options.backchannel.notify({
        sid,
        ...(effectiveSub === undefined ? {} : { sub: effectiveSub }),
        participants,
      });
      void Promise.resolve(delivery).catch(() => undefined);
    }

    const cookie = clearSessionCookie({
      secure: options.cookie.secure,
      path: options.cookie.path ?? '/',
      ...(options.cookie.domain === undefined ? {} : { domain: options.cookie.domain }),
    });
    noStore(reply).header('Set-Cookie', cookie);

    if (requestedRedirect !== undefined) {
      const target = new URL(requestedRedirect);
      if (state !== undefined) {
        target.searchParams.set('state', state);
      }
      return reply.code(302).header('Location', target.toString()).send();
    }
    return reply.code(204).send();
  }

  app.get('/oauth2/logout', handler);
  app.post('/oauth2/logout', handler);
}
