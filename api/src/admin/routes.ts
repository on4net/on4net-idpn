import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { normalizeEmail, normalizeUsername } from '../auth/normalize.js';
import { hashPassword } from '../auth/password.js';
import { PASSWORD_POLICY_MESSAGES, validatePassword } from '../auth/password-policy.js';
import type { AdminAudit, AdminUserRepository, UserStatus } from './admin-types.js';
import {
  authorizeAdminRequest,
  type AdminAuthorization,
  type PermissionReader,
  type TokenVerifier,
} from './authorize.js';
import { DuplicateUserError } from './prisma-user-repository.js';
import {
  createUserSchema,
  listUsersQuerySchema,
  resetPasswordSchema,
  updateUserSchema,
} from './schemas.js';

export interface AdminRoutesOptions {
  issuer: string;
  adminClientId: string;
  verifier: TokenVerifier;
  permissions: PermissionReader;
  users: AdminUserRepository;
  audit: AdminAudit;
  /** Hash used for bootstrap/temporary passwords; defaults to Argon2id. */
  hashPassword?: (plain: string) => Promise<string>;
  /** Temporary password factory; injectable for deterministic tests. */
  generatePassword?: () => string;
  now?: () => Date;
}

const PROBLEM_BASE = 'https://on4net.dev/problems';

type ProblemSlug =
  'unauthorized' | 'forbidden' | 'invalid-request' | 'validation-error' | 'not-found' | 'conflict';

export function sendProblem(
  reply: FastifyReply,
  status: 400 | 401 | 403 | 404 | 409 | 422,
  slug: ProblemSlug,
  title: string,
  detail: string,
  instance?: string,
): FastifyReply {
  return reply
    .code(status)
    .header('Content-Type', 'application/problem+json')
    .send({
      type: `${PROBLEM_BASE}/${slug}`,
      title,
      status,
      detail,
      ...(instance === undefined ? {} : { instance }),
    });
}

const sendAuthFailure = (reply: FastifyReply, auth: Extract<AdminAuthorization, { ok: false }>) => {
  if (auth.status === 401) {
    reply.header('WWW-Authenticate', 'Bearer error="invalid_token"');
  }
  return sendProblem(
    reply,
    auth.status,
    auth.status === 401 ? 'unauthorized' : 'forbidden',
    auth.status === 401 ? 'Unauthorized' : 'Forbidden',
    auth.message,
  );
};

const defaultGeneratePassword = (): string => randomBytes(18).toString('base64url');

/** Registers the global Admin API user endpoints (docs/api.md 3, 3.1, 3.2). */
export function registerAdminRoutes(app: FastifyInstance, options: AdminRoutesOptions): void {
  const now = options.now ?? (() => new Date());
  const hash = options.hashPassword ?? ((plain: string) => hashPassword(plain));
  const generatePassword = options.generatePassword ?? defaultGeneratePassword;

  const authorize = async (
    request: FastifyRequest,
    reply: FastifyReply,
    permission: string,
  ): Promise<{ ok: true; userId: string; clientId: string } | null> => {
    const auth = await authorizeAdminRequest(
      request,
      {
        issuer: options.issuer,
        adminClientId: options.adminClientId,
        verifier: options.verifier,
        permissions: options.permissions,
      },
      permission,
    );
    if (!auth.ok) {
      void sendAuthFailure(reply, auth);
      return null;
    }
    return { ok: true, userId: auth.principal.userId, clientId: auth.principal.clientId };
  };

  const audit = async (
    request: FastifyRequest,
    principal: { userId: string; clientId: string },
    action: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> => {
    await options.audit.record({
      actorType: 'admin',
      actorId: principal.userId,
      action,
      targetType: 'user',
      targetId,
      clientId: principal.clientId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'success',
      metadata,
    });
  };

  app.get('/api/v1/me', async (request, reply) => {
    const auth = await authorizeAdminRequest(
      request,
      {
        issuer: options.issuer,
        adminClientId: options.adminClientId,
        verifier: options.verifier,
        permissions: options.permissions,
      },
      'idp:user:read',
    );
    if (!auth.ok) {
      return sendAuthFailure(reply, auth);
    }
    return reply.send({
      id: auth.principal.userId,
      clientId: auth.principal.clientId,
      scopes: auth.principal.scopes,
      permissions: [...auth.principal.permissions].sort(),
    });
  });

  app.get('/api/v1/users', async (request, reply) => {
    const principal = await authorize(request, reply, 'idp:user:read');
    if (principal === null) {
      return reply;
    }
    const parsed = listUsersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        '/api/v1/users',
      );
    }
    const { page, limit, q, status, sort } = parsed.data;
    const result = await options.users.list({
      page,
      limit,
      sort,
      ...(q === undefined ? {} : { query: q }),
      ...(status === undefined ? {} : { status }),
    });
    return reply.send({ items: result.items, page, limit, total: result.total });
  });

  app.post('/api/v1/users', async (request, reply) => {
    const principal = await authorize(request, reply, 'idp:user:write');
    if (principal === null) {
      return reply;
    }
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        '/api/v1/users',
      );
    }
    const body = parsed.data;
    const email = normalizeEmail(body.email);
    const username = normalizeUsername(body.username);

    if ((await options.users.findIdByEmailOrUsername(email, username)) !== null) {
      return sendProblem(
        reply,
        409,
        'conflict',
        'Conflict',
        'a user with this email or username already exists',
        '/api/v1/users',
      );
    }

    const generated = body.password === undefined;
    const plain = body.password ?? generatePassword();
    if (body.password !== undefined) {
      const violations = validatePassword(plain, { email, username });
      if (violations.length > 0) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          violations.map((violation) => PASSWORD_POLICY_MESSAGES[violation]).join(' '),
          '/api/v1/users',
        );
      }
    }

    let created;
    try {
      created = await options.users.create({
        username,
        email,
        displayName: body.displayName,
        phone: body.phone ?? null,
        locale: body.locale,
        status: body.status,
        passwordHash: await hash(plain),
        mustChangePassword: generated,
      });
    } catch (error) {
      if (error instanceof DuplicateUserError) {
        return sendProblem(
          reply,
          409,
          'conflict',
          'Conflict',
          `${error.field} is already taken`,
          '/api/v1/users',
        );
      }
      throw error;
    }

    await audit(request, principal, 'user.create', created.id, { status: created.status });
    return reply.code(201).send({
      user: created,
      ...(generated ? { temporaryPassword: plain } : {}),
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/users/:id', async (request, reply) => {
    const principal = await authorize(request, reply, 'idp:user:read');
    if (principal === null) {
      return reply;
    }
    const user = await options.users.findById(request.params.id);
    if (user === null) {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'user does not exist');
    }
    return reply.send(user);
  });

  app.patch<{ Params: { id: string } }>('/api/v1/users/:id', async (request, reply) => {
    const principal = await authorize(request, reply, 'idp:user:write');
    if (principal === null) {
      return reply;
    }
    const parsed = updateUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      );
    }
    const body = parsed.data;
    let updated;
    try {
      updated = await options.users.update(request.params.id, {
        ...body,
        ...(body.email === undefined ? {} : { email: normalizeEmail(body.email) }),
      });
    } catch (error) {
      if (error instanceof DuplicateUserError) {
        return sendProblem(reply, 409, 'conflict', 'Conflict', `${error.field} is already taken`);
      }
      throw error;
    }
    if (updated === null) {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'user does not exist');
    }
    await audit(request, principal, 'user.update', updated.id, {
      fields: Object.keys(body).sort(),
    });
    return reply.send(updated);
  });

  const statusAction = (
    path: string,
    action: string,
    status: UserStatus,
    withSessionRevocation: boolean,
  ) => {
    app.post<{ Params: { id: string } }>(path, async (request, reply) => {
      const principal = await authorize(request, reply, 'idp:user:write');
      if (principal === null) {
        return reply;
      }
      const user = await options.users.setStatus(request.params.id, status, {
        clearLock: true,
      });
      if (user === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'user does not exist');
      }
      let revokedSessions = 0;
      if (withSessionRevocation) {
        revokedSessions = await options.users.revokeSessions(user.id, {
          revokedAt: now(),
          reason: status === 'disabled' ? 'admin_disabled' : 'admin_action',
        });
        await options.users.revokeRefreshTokens(user.id, now());
      }
      await audit(request, principal, action, user.id, { status, revokedSessions });
      return reply.send({ user, revokedSessions });
    });
  };

  statusAction('/api/v1/users/:id/disable', 'user.disable', 'disabled', true);
  statusAction('/api/v1/users/:id/enable', 'user.enable', 'active', false);
  statusAction('/api/v1/users/:id/unlock', 'user.unlock', 'active', false);

  app.post<{ Params: { id: string } }>(
    '/api/v1/users/:id/reset-password',
    async (request, reply) => {
      const principal = await authorize(request, reply, 'idp:user:write');
      if (principal === null) {
        return reply;
      }
      const parsed = resetPasswordSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          parsed.error.issues.map((issue) => issue.message).join('; '),
        );
      }
      const existing = await options.users.findById(request.params.id);
      if (existing === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'user does not exist');
      }

      const plain = parsed.data.password ?? generatePassword();
      if (parsed.data.password !== undefined) {
        const violations = validatePassword(plain, {
          email: existing.email,
          username: existing.username,
        });
        if (violations.length > 0) {
          return sendProblem(
            reply,
            422,
            'validation-error',
            'Validation failed',
            violations.map((violation) => PASSWORD_POLICY_MESSAGES[violation]).join(' '),
          );
        }
      }

      const updated = await options.users.setPassword(existing.id, await hash(plain), true);
      if (updated === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'user does not exist');
      }
      const revokedSessions = await options.users.revokeSessions(updated.id, {
        revokedAt: now(),
        reason: 'password_reset',
      });
      await options.users.revokeRefreshTokens(updated.id, now());
      await audit(request, principal, 'user.reset_password', updated.id, { revokedSessions });
      return reply.send({
        user: updated,
        revokedSessions,
        ...(parsed.data.password === undefined ? { temporaryPassword: plain } : {}),
      });
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/users/:id/sessions', async (request, reply) => {
    const principal = await authorize(request, reply, 'idp:session:read');
    if (principal === null) {
      return reply;
    }
    const user = await options.users.findById(request.params.id);
    if (user === null) {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'user does not exist');
    }
    return reply.send({ items: await options.users.listSessions(user.id) });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/users/:id/sessions', async (request, reply) => {
    const principal = await authorize(request, reply, 'idp:session:write');
    if (principal === null) {
      return reply;
    }
    const user = await options.users.findById(request.params.id);
    if (user === null) {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'user does not exist');
    }
    const revoked = await options.users.revokeSessions(user.id, {
      revokedAt: now(),
      reason: 'admin_revoked',
    });
    await options.users.revokeRefreshTokens(user.id, now());
    await audit(request, principal, 'session.revoke_all', user.id, { revoked });
    return reply.send({ revoked });
  });

  app.delete<{ Params: { id: string; sid: string } }>(
    '/api/v1/users/:id/sessions/:sid',
    async (request, reply) => {
      const principal = await authorize(request, reply, 'idp:session:write');
      if (principal === null) {
        return reply;
      }
      const user = await options.users.findById(request.params.id);
      if (user === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'user does not exist');
      }
      const revoked = await options.users.revokeSessions(user.id, {
        revokedAt: now(),
        reason: 'admin_revoked',
        sessionId: request.params.sid,
      });
      if (revoked === 0) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'session does not exist');
      }
      await audit(request, principal, 'session.revoke', user.id, {
        sessionId: request.params.sid,
      });
      return reply.send({ revoked });
    },
  );
}
