import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AdminAudit } from '../admin-types.js';
import { createMemoryRateLimiter, type RateLimiter } from '../../http/rate-limit.js';
import {
  authorizeAdminRequest,
  type AdminAuthorization,
  type AdminRequirement,
  type PermissionReader,
  type TokenVerifier,
} from '../authorize.js';
import { sendProblem } from '../routes.js';
import {
  inviteMemberSchema,
  listMembersQuerySchema,
  replaceMemberRolesSchema,
  updateMemberSchema,
} from './member-schemas.js';
import type { AdminMemberRepository, MemberResult } from './member-types.js';

export interface MemberRoutesOptions {
  issuer: string;
  adminClientId: string;
  verifier: TokenVerifier;
  permissions: PermissionReader;
  members: AdminMemberRepository;
  audit: AdminAudit;
  /**
   * Sends the invitation/notification mail. Omitted in deployments without SMTP; the invite
   * itself still succeeds and the resend endpoint answers `503`.
   */
  notifications?: {
    sendInvite(userId: string): Promise<'invitation' | 'notification' | 'skipped'>;
  };
  /** Shared limiter for resend; a per-process limiter is used when omitted. */
  rateLimit?: RateLimiter;
}

const MEMBER_READ = 'idp:client-member:read';
const MEMBER_INVITE = 'idp:client-member:invite';
const MEMBER_WRITE = 'idp:client-member:write';
const ROLE_ASSIGN = 'idp:client-role:assign';
const SESSION_READ = 'idp:client-session:read';

const validationDetail = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

/** Registers the client membership endpoints (docs/api.md 3.3.1). */
export function registerMemberAdminRoutes(
  app: FastifyInstance,
  options: MemberRoutesOptions,
): void {
  const resendLimiter = options.rateLimit ?? createMemoryRateLimiter();
  const guard = async (
    request: FastifyRequest,
    reply: FastifyReply,
    requirement: AdminRequirement,
  ): Promise<{ userId: string; mode: 'global' | 'delegated' } | null> => {
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
        reply.header('WWW-Authenticate', 'Bearer error="invalid_token"');
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
    return { userId: auth.principal.userId, mode: auth.principal.mode };
  };

  const audit = async (
    request: FastifyRequest,
    principal: { userId: string },
    action: string,
    clientId: string,
    membershipId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> => {
    await options.audit.record({
      actorType: 'admin',
      actorId: principal.userId,
      action,
      targetType: 'membership',
      targetId: membershipId,
      clientId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'success',
      metadata,
    });
  };

  const sendFailure = (
    reply: FastifyReply,
    result: Extract<MemberResult<unknown>, { ok: false }>,
  ) => {
    switch (result.reason) {
      case 'client-not-found':
      case 'context-not-found':
      case 'not-found':
        return sendProblem(reply, 404, 'not-found', 'Not found', result.detail);
      case 'duplicate':
        return sendProblem(reply, 409, 'conflict', 'Conflict', result.detail);
      default:
        return sendProblem(reply, 422, 'validation-error', 'Validation failed', result.detail);
    }
  };

  /**
   * Context endpoints are authorized twice (docs/login-contexts.md 8): the delegated token
   * must belong to the path client (handled by `guard`), and the caller must administer the
   * addressed context. A global admin is not restricted; a delegated admin with only
   * context memberships is limited to those contexts. Denials are audited.
   */
  const guardContext = async (
    request: FastifyRequest,
    reply: FastifyReply,
    clientId: string,
    contextKey: string,
    requirement: AdminRequirement,
  ): Promise<{ userId: string; mode: 'global' | 'delegated' } | null> => {
    const principal = await guard(request, reply, { ...requirement, clientId });
    if (principal === null) {
      return null;
    }
    if (principal.mode === 'global') {
      return principal;
    }
    const scope = await options.members.adminContextScope(clientId, principal.userId);
    if (scope === 'all' || (scope !== null && scope.includes(contextKey))) {
      return principal;
    }
    await options.audit.record({
      actorType: 'admin',
      actorId: principal.userId,
      action: 'member.context.denied',
      targetType: 'login_context',
      // `target_id` is a UUID column and the context key is not one; the key is carried in
      // metadata instead, next to the client id.
      targetId: null,
      clientId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'failure',
      metadata: {
        userId: principal.userId,
        loginContext: contextKey,
        reason: scope === null ? 'no-context-membership' : 'cross-context',
      },
    });
    void sendProblem(
      reply,
      403,
      'forbidden',
      'Forbidden',
      'login context is outside the administrator scope',
    );
    return null;
  };

  app.get<{ Params: { clientId: string } }>(
    '/api/v1/clients/:clientId/members',
    async (request, reply) => {
      const clientId = request.params.clientId;
      if ((await guard(request, reply, { permission: MEMBER_READ, clientId })) === null) {
        return reply;
      }
      const parsed = listMembersQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          validationDetail(parsed.error),
        );
      }
      const { page, limit, status, q } = parsed.data;
      const result = await options.members.list(clientId, {
        page,
        limit,
        ...(status === undefined ? {} : { status }),
        ...(q === undefined ? {} : { query: q }),
      });
      if (result === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
      }
      return reply.send({ items: result.items, page, limit, total: result.total });
    },
  );

  app.post<{ Params: { clientId: string } }>(
    '/api/v1/clients/:clientId/members/invite',
    async (request, reply) => {
      const clientId = request.params.clientId;
      const principal = await guard(request, reply, { permission: MEMBER_INVITE, clientId });
      if (principal === null) {
        return reply;
      }
      const parsed = inviteMemberSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          validationDetail(parsed.error),
        );
      }
      const result = await options.members.invite(clientId, {
        email: parsed.data.email,
        ...(parsed.data.displayName === undefined ? {} : { displayName: parsed.data.displayName }),
        roleKeys: parsed.data.roleKeys,
        attributes: parsed.data.attributes,
        invitedBy: principal.userId,
      });
      if (!result.ok) {
        return sendFailure(reply, result);
      }
      const { member, createdUser } = result.value;
      let delivery: 'invitation' | 'notification' | 'skipped' | 'mail_failed' | 'disabled' =
        'disabled';
      if (options.notifications !== undefined) {
        try {
          delivery = await options.notifications.sendInvite(member.userId);
        } catch (error) {
          delivery = 'mail_failed';
          // Mail bodies carry invite tokens; log only the transport error.
          const message = error instanceof Error ? error.message : 'unknown error';
          console.error(`invite mail failed: ${message}`);
        }
      }
      await audit(request, principal, 'member.invite', clientId, member.membershipId, {
        userId: member.userId,
        roleKeys: member.roleKeys,
        createdUser,
        delivery,
      });
      return reply.code(201).send({ member, createdUser, invited: true });
    },
  );

  app.post<{ Params: { clientId: string; userId: string } }>(
    '/api/v1/clients/:clientId/members/:userId/invite/resend',
    async (request, reply) => {
      const { clientId, userId } = request.params;
      const principal = await guard(request, reply, { permission: MEMBER_INVITE, clientId });
      if (principal === null) {
        return reply;
      }
      const member = await options.members.find(clientId, userId);
      if (member === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'membership does not exist');
      }
      if (member.status !== 'invited') {
        return sendProblem(
          reply,
          409,
          'conflict',
          'Conflict',
          'only a pending invitation can be resent',
        );
      }
      // 5 resends per hour per membership (docs/security.md 3.2, email sending limit).
      if (
        !(await resendLimiter.consume(`member-invite-resend:${clientId}:${userId}`, {
          windowSeconds: 3600,
          max: 5,
        }))
      ) {
        reply.header('Retry-After', '3600');
        return sendProblem(reply, 429, 'rate-limited', 'Too many requests', 'try again later');
      }
      if (options.notifications === undefined) {
        return sendProblem(
          reply,
          503,
          'service-unavailable',
          'Service unavailable',
          'mail delivery is not configured',
        );
      }

      let delivery: 'invitation' | 'notification' | 'skipped';
      try {
        delivery = await options.notifications.sendInvite(userId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        console.error(`invite resend mail failed: ${message}`);
        await audit(
          request,
          principal,
          'member.invite.resend_failed',
          clientId,
          member.membershipId,
          {
            userId,
          },
        );
        return sendProblem(
          reply,
          503,
          'service-unavailable',
          'Service unavailable',
          'invitation mail could not be sent',
        );
      }
      if (delivery === 'skipped') {
        return sendProblem(
          reply,
          409,
          'conflict',
          'Conflict',
          'the invited account is no longer available',
        );
      }
      await audit(request, principal, 'member.invite.resend', clientId, member.membershipId, {
        userId,
        delivery,
      });
      return reply.code(202).send({ status: 'accepted', delivery });
    },
  );

  app.get<{ Params: { clientId: string; userId: string } }>(
    '/api/v1/clients/:clientId/members/:userId',
    async (request, reply) => {
      const { clientId, userId } = request.params;
      if ((await guard(request, reply, { permission: MEMBER_READ, clientId })) === null) {
        return reply;
      }
      const member = await options.members.find(clientId, userId);
      if (member === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'membership does not exist');
      }
      return reply.send(member);
    },
  );

  app.patch<{ Params: { clientId: string; userId: string } }>(
    '/api/v1/clients/:clientId/members/:userId',
    async (request, reply) => {
      const { clientId, userId } = request.params;
      const principal = await guard(request, reply, { permission: MEMBER_WRITE, clientId });
      if (principal === null) {
        return reply;
      }
      const parsed = updateMemberSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          validationDetail(parsed.error),
        );
      }
      const existing = await options.members.find(clientId, userId);
      if (existing === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'membership does not exist');
      }
      const result = await options.members.update(clientId, userId, parsed.data);
      if (!result.ok) {
        return sendFailure(reply, result);
      }
      await audit(
        request,
        principal,
        parsed.data.status === 'suspended' ? 'member.suspend' : 'member.update',
        clientId,
        result.value.membershipId,
        {
          userId,
          ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
          ...(parsed.data.attributes === undefined
            ? {}
            : { attributeKeys: Object.keys(parsed.data.attributes).sort() }),
        },
      );
      return reply.send(result.value);
    },
  );

  app.delete<{ Params: { clientId: string; userId: string } }>(
    '/api/v1/clients/:clientId/members/:userId',
    async (request, reply) => {
      const { clientId, userId } = request.params;
      const principal = await guard(request, reply, { permission: MEMBER_WRITE, clientId });
      if (principal === null) {
        return reply;
      }
      const existing = await options.members.find(clientId, userId);
      if (existing === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'membership does not exist');
      }
      await options.members.remove(clientId, userId);
      await audit(request, principal, 'member.remove', clientId, existing.membershipId, {
        userId,
      });
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { clientId: string; userId: string } }>(
    '/api/v1/clients/:clientId/members/:userId/roles',
    async (request, reply) => {
      const { clientId, userId } = request.params;
      const principal = await guard(request, reply, {
        permission: ROLE_ASSIGN,
        clientId,
        stepUp: true,
      });
      if (principal === null) {
        return reply;
      }
      const parsed = replaceMemberRolesSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          validationDetail(parsed.error),
        );
      }
      const result = await options.members.replaceRoles(
        clientId,
        userId,
        parsed.data.roleKeys,
        principal.userId,
      );
      if (!result.ok) {
        return sendFailure(reply, result);
      }
      await audit(request, principal, 'member.roles.replace', clientId, result.value.membershipId, {
        userId,
        roleKeys: result.value.roleKeys,
      });
      return reply.send(result.value);
    },
  );

  app.get<{ Params: { clientId: string; userId: string } }>(
    '/api/v1/clients/:clientId/members/:userId/sessions',
    async (request, reply) => {
      const { clientId, userId } = request.params;
      if ((await guard(request, reply, { permission: SESSION_READ, clientId })) === null) {
        return reply;
      }
      const member = await options.members.find(clientId, userId);
      if (member === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'membership does not exist');
      }
      return reply.send({ items: await options.members.listSessions(clientId, userId) });
    },
  );

  // ---------------------------------------------------------------------------------------
  // Context-scoped memberships (docs/api.md 3.3.3, docs/login-contexts.md 7.3 and 8).
  // The path always names both the client and the context; every repository call is keyed by
  // `(clientId, login_context_id, userId)` so two contexts of one app stay independent.
  // ---------------------------------------------------------------------------------------

  app.get<{ Params: { clientId: string; key: string } }>(
    '/api/v1/clients/:clientId/login-contexts/:key/members',
    async (request, reply) => {
      const { clientId, key } = request.params;
      if (
        (await guardContext(request, reply, clientId, key, { permission: MEMBER_READ })) === null
      ) {
        return reply;
      }
      const parsed = listMembersQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          validationDetail(parsed.error),
        );
      }
      const { page, limit, status, q } = parsed.data;
      const result = await options.members.list(
        clientId,
        {
          page,
          limit,
          ...(status === undefined ? {} : { status }),
          ...(q === undefined ? {} : { query: q }),
        },
        { loginContext: key },
      );
      if (result === null) {
        return sendProblem(
          reply,
          404,
          'not-found',
          'Not found',
          'client or login context does not exist',
        );
      }
      return reply.send({ items: result.items, page, limit, total: result.total });
    },
  );

  app.post<{ Params: { clientId: string; key: string } }>(
    '/api/v1/clients/:clientId/login-contexts/:key/members/invite',
    async (request, reply) => {
      const { clientId, key } = request.params;
      const principal = await guardContext(request, reply, clientId, key, {
        permission: MEMBER_INVITE,
      });
      if (principal === null) {
        return reply;
      }
      const parsed = inviteMemberSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          validationDetail(parsed.error),
        );
      }
      const result = await options.members.invite(
        clientId,
        {
          email: parsed.data.email,
          ...(parsed.data.displayName === undefined
            ? {}
            : { displayName: parsed.data.displayName }),
          roleKeys: parsed.data.roleKeys,
          attributes: parsed.data.attributes,
          invitedBy: principal.userId,
        },
        { loginContext: key },
      );
      if (!result.ok) {
        return sendFailure(reply, result);
      }
      const { member, createdUser } = result.value;
      let delivery: 'invitation' | 'notification' | 'skipped' | 'mail_failed' | 'disabled' =
        'disabled';
      if (options.notifications !== undefined) {
        try {
          delivery = await options.notifications.sendInvite(member.userId);
        } catch (error) {
          delivery = 'mail_failed';
          // Mail bodies carry invite tokens; log only the transport error.
          const message = error instanceof Error ? error.message : 'unknown error';
          console.error(`invite mail failed: ${message}`);
        }
      }
      await audit(request, principal, 'member.invite', clientId, member.membershipId, {
        userId: member.userId,
        roleKeys: member.roleKeys,
        createdUser,
        delivery,
        loginContext: key,
      });
      return reply.code(201).send({ member, createdUser, invited: true });
    },
  );

  app.get<{ Params: { clientId: string; key: string; userId: string } }>(
    '/api/v1/clients/:clientId/login-contexts/:key/members/:userId',
    async (request, reply) => {
      const { clientId, key, userId } = request.params;
      if (
        (await guardContext(request, reply, clientId, key, { permission: MEMBER_READ })) === null
      ) {
        return reply;
      }
      const member = await options.members.find(clientId, userId, { loginContext: key });
      if (member === null) {
        return sendProblem(
          reply,
          404,
          'not-found',
          'Not found',
          'membership does not exist in this login context',
        );
      }
      return reply.send(member);
    },
  );

  app.patch<{ Params: { clientId: string; key: string; userId: string } }>(
    '/api/v1/clients/:clientId/login-contexts/:key/members/:userId',
    async (request, reply) => {
      const { clientId, key, userId } = request.params;
      const principal = await guardContext(request, reply, clientId, key, {
        permission: MEMBER_WRITE,
      });
      if (principal === null) {
        return reply;
      }
      const parsed = updateMemberSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          validationDetail(parsed.error),
        );
      }
      const result = await options.members.update(clientId, userId, parsed.data, {
        loginContext: key,
      });
      if (!result.ok) {
        return sendFailure(reply, result);
      }
      await audit(
        request,
        principal,
        parsed.data.status === 'suspended' ? 'member.suspend' : 'member.update',
        clientId,
        result.value.membershipId,
        {
          userId,
          loginContext: key,
          ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
          ...(parsed.data.attributes === undefined
            ? {}
            : { attributeKeys: Object.keys(parsed.data.attributes).sort() }),
        },
      );
      return reply.send(result.value);
    },
  );

  app.delete<{ Params: { clientId: string; key: string; userId: string } }>(
    '/api/v1/clients/:clientId/login-contexts/:key/members/:userId',
    async (request, reply) => {
      const { clientId, key, userId } = request.params;
      const principal = await guardContext(request, reply, clientId, key, {
        permission: MEMBER_WRITE,
      });
      if (principal === null) {
        return reply;
      }
      const existing = await options.members.find(clientId, userId, { loginContext: key });
      if (existing === null) {
        return sendProblem(
          reply,
          404,
          'not-found',
          'Not found',
          'membership does not exist in this login context',
        );
      }
      const result = await options.members.remove(clientId, userId, { loginContext: key });
      if (result !== 'deleted') {
        return sendProblem(
          reply,
          404,
          'not-found',
          'Not found',
          'membership does not exist in this login context',
        );
      }
      await audit(request, principal, 'member.remove', clientId, existing.membershipId, {
        userId,
        loginContext: key,
      });
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { clientId: string; key: string; userId: string } }>(
    '/api/v1/clients/:clientId/login-contexts/:key/members/:userId/roles',
    async (request, reply) => {
      const { clientId, key, userId } = request.params;
      const principal = await guardContext(request, reply, clientId, key, {
        permission: ROLE_ASSIGN,
        stepUp: true,
      });
      if (principal === null) {
        return reply;
      }
      const parsed = replaceMemberRolesSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          validationDetail(parsed.error),
        );
      }
      const result = await options.members.replaceRoles(
        clientId,
        userId,
        parsed.data.roleKeys,
        principal.userId,
        { loginContext: key },
      );
      if (!result.ok) {
        return sendFailure(reply, result);
      }
      await audit(request, principal, 'member.roles.replace', clientId, result.value.membershipId, {
        userId,
        roleKeys: result.value.roleKeys,
        loginContext: key,
      });
      return reply.send(result.value);
    },
  );
}
