import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AdminAudit } from '../admin-types.js';
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
      case 'not-found':
        return sendProblem(reply, 404, 'not-found', 'Not found', result.detail);
      case 'duplicate':
        return sendProblem(reply, 409, 'conflict', 'Conflict', result.detail);
      default:
        return sendProblem(reply, 422, 'validation-error', 'Validation failed', result.detail);
    }
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
      await audit(request, principal, 'member.invite', clientId, member.membershipId, {
        userId: member.userId,
        roleKeys: member.roleKeys,
        createdUser,
      });
      return reply.code(201).send({ member, createdUser, invited: true });
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
}
