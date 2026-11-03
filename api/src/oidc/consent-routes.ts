import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { hasJsonContentType, isSameOriginRequest, sendProblem } from '../account/routes.js';
import type { AdminAudit } from '../admin/admin-types.js';
import { readSessionId } from '../session/cookie.js';
import type { IdpSession } from '../session/types.js';
import type { ClientRepository } from './client-repository.js';
import type { ConsentRepository, ConsentRequestStore } from './consent.js';
import { buildErrorRedirect, oauthError } from './oauth-error.js';

/**
 * Same-origin API behind the Hosted UI consent screen (card #81).
 *
 * The screen never sees an authorize URL it could tamper with: `/oauth2/authorize` stores the
 * validated request server-side and hands the page an opaque handle. The page reads what is
 * being asked (client name, scopes), the user decides, and the server resumes or aborts the
 * authorization from its own copy. Everything is cookie-authenticated and CSRF-guarded by an
 * exact same-origin check; a handle only works for the user it was issued to.
 */

export interface ConsentRoutesOptions {
  /** Public IdP origin for the same-origin check. */
  appUrl: string;
  sessions: { read(sid: string): Promise<IdpSession | null> };
  requests: ConsentRequestStore;
  consents: ConsentRepository;
  clients: ClientRepository;
  audit: AdminAudit;
  now?: () => Date;
}

const decisionSchema = z.object({ decision: z.enum(['allow', 'deny']) });

const NOT_FOUND = 'consent request not found or expired';

export function registerConsentRoutes(app: FastifyInstance, options: ConsentRoutesOptions): void {
  const now = options.now ?? (() => new Date());

  const session = async (request: FastifyRequest): Promise<IdpSession | null> => {
    const sid = readSessionId(request.headers.cookie);
    return sid === null ? null : options.sessions.read(sid);
  };

  const unauthorized = (reply: FastifyReply): FastifyReply =>
    sendProblem(reply, 401, 'unauthorized', 'Unauthorized', 'sign in first', {
      code: 'login_required',
    });

  const crossOrigin = (reply: FastifyReply): FastifyReply =>
    sendProblem(reply, 403, 'forbidden', 'Forbidden', 'same-origin JSON request required', {
      code: 'cross_origin_request',
    });

  const record = async (
    request: FastifyRequest,
    action: string,
    userId: string,
    clientId: string,
    result: 'success' | 'failure',
    metadata: Record<string, unknown> = {},
  ): Promise<void> => {
    await options.audit.record({
      actorType: 'user',
      actorId: userId,
      action,
      targetType: 'client',
      // `audit_events.target_id` is a UUID; the public client id travels as `clientId`, which
      // the audit adapter resolves, and again in the metadata below.
      targetId: null,
      clientId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result,
      metadata: { clientPublicId: clientId, ...metadata },
    });
  };

  app.get<{ Params: { id: string } }>('/api/v1/consent/requests/:id', async (request, reply) => {
    const current = await session(request);
    if (current === null) {
      return unauthorized(reply);
    }
    const pending = await options.requests.peek(request.params.id);
    // A handle issued to someone else looks exactly like an unknown one.
    if (pending === null || pending.userId !== current.userId) {
      return sendProblem(reply, 404, 'not-found', 'Not found', NOT_FOUND);
    }
    const client = await options.clients.findByClientId(pending.clientId);
    if (client === null || client.status !== 'active') {
      return sendProblem(reply, 404, 'not-found', 'Not found', NOT_FOUND);
    }
    return reply.header('Cache-Control', 'no-store').send({
      client: { clientId: client.clientId, name: client.name ?? client.clientId },
      scopes: pending.scopes,
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/consent/requests/:id/decision',
    async (request, reply) => {
      if (!isSameOriginRequest(request, options.appUrl) || !hasJsonContentType(request)) {
        return crossOrigin(reply);
      }
      const current = await session(request);
      if (current === null) {
        return unauthorized(reply);
      }
      const parsed = decisionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          'decision must be allow or deny',
        );
      }
      const pending = await options.requests.peek(request.params.id);
      if (pending === null || pending.userId !== current.userId) {
        return sendProblem(reply, 404, 'not-found', 'Not found', NOT_FOUND);
      }
      // Consume before acting: two tabs deciding the same request cannot both succeed.
      if ((await options.requests.take(request.params.id)) === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', NOT_FOUND);
      }
      const client = await options.clients.findByClientId(pending.clientId);
      if (client === null || client.status !== 'active') {
        return sendProblem(reply, 404, 'not-found', 'Not found', NOT_FOUND);
      }

      if (parsed.data.decision === 'allow') {
        await options.consents.grant(current.userId, client.clientId, pending.scopes, now());
        await record(request, 'consent.granted', current.userId, client.clientId, 'success', {
          scopes: pending.scopes,
        });
        return reply.header('Cache-Control', 'no-store').send({ redirectTo: pending.authorizeUrl });
      }

      await record(request, 'consent.denied', current.userId, client.clientId, 'failure', {
        scopes: pending.scopes,
      });
      // Abort through the client's redirect URI, but only one that is registered: the stored
      // authorize URL was validated, and this checks it again before the browser follows it.
      const authorizeUrl = new URL(pending.authorizeUrl);
      const redirectUri = authorizeUrl.searchParams.get('redirect_uri');
      const state = authorizeUrl.searchParams.get('state') ?? undefined;
      if (redirectUri === null || !client.redirectUris.includes(redirectUri)) {
        return reply.header('Cache-Control', 'no-store').send({ redirectTo: null });
      }
      return reply.header('Cache-Control', 'no-store').send({
        redirectTo: buildErrorRedirect(
          redirectUri,
          oauthError('access_denied', 'the user denied the request'),
          state,
        ),
      });
    },
  );

  app.get('/api/v1/consent/grants', async (request, reply) => {
    const current = await session(request);
    if (current === null) {
      return unauthorized(reply);
    }
    return reply
      .header('Cache-Control', 'no-store')
      .send({ items: await options.consents.listForUser(current.userId) });
  });

  app.delete<{ Params: { clientId: string } }>(
    '/api/v1/consent/grants/:clientId',
    async (request, reply) => {
      if (!isSameOriginRequest(request, options.appUrl)) {
        return crossOrigin(reply);
      }
      const current = await session(request);
      if (current === null) {
        return unauthorized(reply);
      }
      const revoked = await options.consents.revoke(current.userId, request.params.clientId, now());
      if (!revoked) {
        return sendProblem(
          reply,
          404,
          'not-found',
          'Not found',
          'no active consent for this client',
        );
      }
      await record(request, 'consent.revoked', current.userId, request.params.clientId, 'success');
      return reply.code(204).header('Cache-Control', 'no-store').send();
    },
  );
}
