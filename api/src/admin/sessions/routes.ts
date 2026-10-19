import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AdminAudit, AdminPrincipal } from '../admin-types.js';
import {
  authorizeAdminRequest,
  type AdminAuthorization,
  type AdminRequirement,
  type PermissionReader,
  type TokenVerifier,
} from '../authorize.js';
import { sendProblem } from '../routes.js';
import type { ClientSessionRevoker, SessionRevoker } from '../../session/revocation.js';
import { listSessionsQuerySchema } from './session-schemas.js';
import type { AdminSessionRepository, DelegatedSessionScope } from './session-types.js';

export interface SessionRoutesOptions {
  issuer: string;
  adminClientId: string;
  verifier: TokenVerifier;
  permissions: PermissionReader;
  repository: AdminSessionRepository;
  /** Redis revocation so the next authorize/token request fails immediately. */
  revoker?: SessionRevoker & Partial<ClientSessionRevoker>;
  audit: AdminAudit;
  now?: () => Date;
}

const SESSION_READ = 'idp:session:read';
const SESSION_WRITE = 'idp:session:write';
const CLIENT_SESSION_READ = 'idp:client-session:read';
const CLIENT_SESSION_WRITE = 'idp:client-session:write';

const validationDetail = (issues: { path: PropertyKey[]; message: string }[]): string =>
  issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

/**
 * Session administration and self-service endpoints (docs/api.md 3.1, 3.7).
 *
 * Revocation always updates Redis first: it is the store `/oauth2/authorize` and refresh
 * grants read, so the revoked session is rejected on the very next request. The PostgreSQL
 * mirror is updated for listing and audit.
 */
export function registerSessionAdminRoutes(
  app: FastifyInstance,
  options: SessionRoutesOptions,
): void {
  const now = options.now ?? (() => new Date());

  const guard = async (
    request: FastifyRequest,
    reply: FastifyReply,
    requirement: AdminRequirement,
  ): Promise<AdminPrincipal | null> => {
    const auth: AdminAuthorization = await authorizeAdminRequest(
      request,
      {
        issuer: options.issuer,
        adminClientId: options.adminClientId,
        verifier: options.verifier,
        permissions: options.permissions,
      },
      requirement,
    );
    if (!auth.ok) {
      if (auth.status === 401) {
        reply.header('WWW-Authenticate', '******"invalid_token"');
      }
      void sendProblem(
        reply,
        auth.status,
        auth.status === 401 ? 'unauthorized' : 'forbidden',
        auth.status === 401 ? 'Unauthorized' : 'Forbidden',
        auth.message,
      );
      return null;
    }
    return auth.principal;
  };

  const recordAudit = async (
    request: FastifyRequest,
    event: {
      actorType: 'user' | 'admin';
      actorId: string;
      clientId: string | null;
      action: string;
      targetType: string;
      targetId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> => {
    await options.audit.record({
      actorType: event.actorType,
      actorId: event.actorId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      clientId: event.clientId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'success',
      metadata: event.metadata,
    });
  };

  /**
   * Delegated admins act only inside the app their token was issued to. A token whose app
   * no longer exists cannot be scoped, so it is denied instead of falling back to global.
   */
  const scopeFor = async (
    principal: AdminPrincipal,
  ): Promise<{ ok: true; scope: DelegatedSessionScope | null } | { ok: false }> => {
    if (principal.mode === 'global') {
      return { ok: true, scope: null };
    }
    const clientUuid = await options.repository.resolveClientUuid(principal.clientId);
    return clientUuid === null ? { ok: false } : { ok: true, scope: { clientUuid } };
  };

  const forbidden = (reply: FastifyReply, detail: string): FastifyReply =>
    sendProblem(reply, 403, 'forbidden', 'Forbidden', detail);

  const revokeInRedis = async (sid: string): Promise<void> => {
    await options.revoker?.revoke(sid, 'admin');
  };

  app.get('/api/v1/sessions', async (request, reply) => {
    const principal = await guard(request, reply, {
      permission: SESSION_READ,
      delegatedPermission: CLIENT_SESSION_READ,
      allowDelegated: true,
    });
    if (principal === null) {
      return reply;
    }
    const parsed = listSessionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        validationDetail(parsed.error.issues),
        '/api/v1/sessions',
      );
    }
    const scoped = await scopeFor(principal);
    if (!scoped.ok) {
      return forbidden(reply, 'the token client is not available');
    }
    if (
      scoped.scope !== null &&
      parsed.data.clientId !== undefined &&
      parsed.data.clientId !== principal.clientId
    ) {
      return forbidden(reply, 'a delegated admin can only read its own app sessions');
    }

    const { page, limit, userId, clientId, status } = parsed.data;
    const result = await options.repository.list(
      {
        page,
        limit,
        ...(userId === undefined ? {} : { userId }),
        ...(clientId === undefined ? {} : { clientId }),
        ...(status === undefined ? {} : { status }),
      },
      scoped.scope ?? undefined,
    );
    return reply.send({ items: result.items, page, limit, total: result.total });
  });

  app.delete<{ Params: { sid: string } }>('/api/v1/sessions/:sid', async (request, reply) => {
    const principal = await guard(request, reply, {
      permission: SESSION_WRITE,
      delegatedPermission: CLIENT_SESSION_WRITE,
      allowDelegated: true,
    });
    if (principal === null) {
      return reply;
    }
    const scoped = await scopeFor(principal);
    if (!scoped.ok) {
      return forbidden(reply, 'the token client is not available');
    }
    const session = await options.repository.findById(request.params.sid);
    if (session === null) {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'session does not exist');
    }
    if (scoped.scope !== null) {
      if (session.clientId !== principal.clientId) {
        return forbidden(reply, 'a delegated admin can only revoke its own app sessions');
      }
      if (!(await options.repository.isMember(scoped.scope.clientUuid, session.userId))) {
        return forbidden(reply, 'the user is not a member of this app');
      }
    }

    await revokeInRedis(session.id);
    const at = now();
    const revoked = await options.repository.revoke(session.id, at, 'admin_revoked');
    const revokedRefreshTokens = await options.repository.revokeRefreshTokensForSession(
      session.id,
      at,
    );
    await recordAudit(request, {
      actorType: 'admin',
      actorId: principal.userId,
      clientId: principal.clientId,
      action: 'session.revoke',
      targetType: 'session',
      targetId: session.id,
      metadata: {
        userId: session.userId,
        reason: 'admin_revoked',
        ...(scoped.scope === null ? {} : { appScoped: true }),
        revokedRefreshTokens,
      },
    });
    return reply.send({ revoked: true, alreadyRevoked: !revoked });
  });

  app.post<{ Params: { id: string } }>('/api/v1/users/:id/logout-all', async (request, reply) => {
    const principal = await guard(request, reply, {
      permission: SESSION_WRITE,
      delegatedPermission: CLIENT_SESSION_WRITE,
      allowDelegated: true,
    });
    if (principal === null) {
      return reply;
    }
    const userId = request.params.id;
    if (!(await options.repository.userExists(userId))) {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'user does not exist');
    }
    const scoped = await scopeFor(principal);
    if (!scoped.ok) {
      return forbidden(reply, 'the token client is not available');
    }
    if (
      scoped.scope !== null &&
      !(await options.repository.isMember(scoped.scope.clientUuid, userId))
    ) {
      return forbidden(reply, 'the user is not a member of this app');
    }

    const at = now();
    let revoked: number;
    if (scoped.scope === null) {
      if (options.revoker !== undefined) {
        await options.revoker.revokeAllForUser(userId, 'global_logout');
      }
      revoked = await options.repository.revokeAllForUser(userId, at, 'admin_logout_all');
      await options.repository.revokeRefreshTokensForUser(userId, at);
    } else {
      // Delegated logout-all is app-scoped: other apps of the same user stay signed in.
      if (options.revoker?.revokeForUserClient !== undefined) {
        await options.revoker.revokeForUserClient(userId, principal.clientId, 'admin');
      }
      revoked = await options.repository.revokeAllForUserClient(
        userId,
        scoped.scope.clientUuid,
        at,
        'admin_logout_all',
      );
      // Other apps of the same user must keep their refresh tokens.
      await options.repository.revokeRefreshTokensForUserClient(
        userId,
        scoped.scope.clientUuid,
        at,
      );
    }

    await recordAudit(request, {
      actorType: 'admin',
      actorId: principal.userId,
      clientId: principal.clientId,
      action: 'session.logout_all',
      targetType: 'user',
      targetId: userId,
      metadata: {
        revoked,
        scope: scoped.scope === null ? 'global' : 'app',
        ...(scoped.scope === null ? {} : { clientId: principal.clientId }),
      },
    });
    return reply.send({ revoked });
  });

  app.get('/api/v1/me/sessions', async (request, reply) => {
    const principal = await guard(request, reply, {
      permission: '',
      authenticatedOnly: true,
      allowDelegated: true,
    });
    if (principal === null) {
      return reply;
    }
    const parsed = listSessionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        validationDetail(parsed.error.issues),
        '/api/v1/me/sessions',
      );
    }
    const { page, limit, status } = parsed.data;
    const result = await options.repository.list({
      page,
      limit,
      userId: principal.userId,
      // The self-service surface lists active sessions by default (docs/api.md 3.1).
      status: status ?? 'active',
    });
    return reply.send({ items: result.items, page, limit, total: result.total });
  });

  app.delete<{ Params: { sid: string } }>('/api/v1/me/sessions/:sid', async (request, reply) => {
    const principal = await guard(request, reply, {
      permission: '',
      authenticatedOnly: true,
      allowDelegated: true,
    });
    if (principal === null) {
      return reply;
    }
    const session = await options.repository.findById(request.params.sid);
    // A foreign session must look exactly like an unknown one (docs/api.md 3.1).
    if (session === null || session.userId !== principal.userId) {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'session does not exist');
    }

    await revokeInRedis(session.id);
    const at = now();
    const revoked = await options.repository.revoke(session.id, at, 'user_revoked');
    await options.repository.revokeRefreshTokensForSession(session.id, at);
    await recordAudit(request, {
      actorType: 'user',
      actorId: principal.userId,
      clientId: principal.clientId,
      action: 'session.revoke',
      targetType: 'session',
      targetId: session.id,
      metadata: { userId: session.userId, reason: 'user_revoked', selfService: true },
    });
    return reply.send({ revoked: true, alreadyRevoked: !revoked });
  });
}
