import { randomBytes } from 'node:crypto';

import type { PrismaClient } from '../../generated/prisma/client.js';
import { normalizeEmail } from '../../auth/normalize.js';
import type { ClientSessionRevoker } from '../../session/revocation.js';
import type { AdminRbacRepository } from '../rbac/rbac-types.js';
import { contextRoleProblems, validateMembershipAttributes } from './member-validation.js';
import type {
  AdminMember,
  AdminMemberRepository,
  AdminMemberSession,
  ContextAdminScope,
  InviteMemberInput,
  ListMembersQuery,
  MemberFailure,
  MemberResult,
  MembershipStatus,
  MemberScope,
  UpdateMemberInput,
} from './member-types.js';

interface MemberRow {
  id: string;
  status: string;
  attributes: unknown;
  invitedAt: Date | null;
  joinedAt: Date | null;
  lastAccessAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  user: {
    id: string;
    email: string;
    username: string;
    displayName: string;
    status: string;
  };
  loginContext: { key: string } | null;
}

const MEMBER_SELECT = {
  id: true,
  status: true,
  attributes: true,
  invitedAt: true,
  joinedAt: true,
  lastAccessAt: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      email: true,
      username: true,
      displayName: true,
      status: true,
    },
  },
  loginContext: { select: { key: true } },
} as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toAttributes = (value: unknown): Record<string, unknown> =>
  isPlainObject(value) ? value : {};

const toMember = (row: MemberRow, roleKeys: string[]): AdminMember => ({
  membershipId: row.id,
  userId: row.user.id,
  email: row.user.email,
  username: row.user.username,
  displayName: row.user.displayName,
  userStatus: row.user.status as AdminMember['userStatus'],
  status: row.status as MembershipStatus,
  attributes: toAttributes(row.attributes),
  loginContextKey: row.loginContext?.key ?? null,
  roleKeys: [...roleKeys].sort(),
  invitedAt: row.invitedAt?.toISOString() ?? null,
  joinedAt: row.joinedAt?.toISOString() ?? null,
  lastAccessAt: row.lastAccessAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const usernameFromEmail = (email: string): string => {
  const local = email.split('@')[0] ?? '';
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 48);
  return cleaned.length >= 3 ? cleaned : 'user';
};

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

const failure = (reason: MemberFailure, detail: string): MemberResult<never> => ({
  ok: false,
  reason,
  detail,
});

/** The Login Context a membership belongs to; `null` is the client-wide (default) scope. */
interface MembershipContext {
  id: string;
  key: string;
  allowedRoles: string[];
  defaultRoles: string[];
}

type ResolvedScope =
  | {
      ok: true;
      client: { id: string; tenantId: string; membershipSchema: unknown };
      context: MembershipContext | null;
    }
  | { ok: false; reason: 'client-not-found' | 'context-not-found'; detail: string };

export interface PrismaMemberRepositoryOptions {
  /** Used to apply the client's `is_default` roles on the first client-wide membership. */
  rbac?: Pick<AdminRbacRepository, 'assignDefaultRoles'>;
  /** Revokes the app's Redis sessions when a membership is suspended. */
  sessions?: ClientSessionRevoker;
  now?: () => Date;
}

/** Prisma-backed client membership repository. */
export function createPrismaMemberRepository(
  prisma: PrismaClient,
  options: PrismaMemberRepositoryOptions = {},
): AdminMemberRepository {
  const now = options.now ?? (() => new Date());

  const resolveClient = async (clientId: string) =>
    prisma.client.findUnique({
      where: { clientId },
      select: { id: true, tenantId: true, membershipSchema: true },
    });

  const resolveContext = async (
    clientUuid: string,
    key: string,
  ): Promise<MembershipContext | null> =>
    prisma.clientLoginContext.findFirst({
      where: { clientId: clientUuid, key },
      select: { id: true, key: true, allowedRoles: true, defaultRoles: true },
    });

  /**
   * Resolves the client plus, when a context was requested, that exact context of the client.
   * A context key belonging to another client is a 404 for this client, never a cross-client
   * read (docs/login-contexts.md 6).
   */
  const resolveScope = async (clientId: string, scope?: MemberScope): Promise<ResolvedScope> => {
    const client = await resolveClient(clientId);
    if (client === null) {
      return {
        ok: false,
        reason: 'client-not-found',
        detail: `client "${clientId}" does not exist`,
      };
    }
    if (scope?.loginContext === undefined) {
      return { ok: true, client, context: null };
    }
    const context = await resolveContext(client.id, scope.loginContext);
    if (context === null) {
      return {
        ok: false,
        reason: 'context-not-found',
        detail: `login context "${scope.loginContext}" does not exist`,
      };
    }
    return { ok: true, client, context };
  };

  /**
   * Role keys the subject holds in the client. For a context the result is narrowed to
   * `allowed_roles`, so an admin never sees (or is led to believe they can edit) roles the
   * context cannot grant (docs/login-contexts.md 5).
   */
  const roleKeysFor = async (
    clientUuid: string,
    userIds: string[],
    allowedRoles?: readonly string[],
  ) => {
    if (userIds.length === 0) {
      return new Map<string, string[]>();
    }
    const rows = await prisma.assignment.findMany({
      where: {
        subjectType: 'user',
        subjectId: { in: userIds },
        role: {
          clientId: clientUuid,
          ...(allowedRoles === undefined ? {} : { key: { in: [...allowedRoles] } }),
        },
      },
      select: { subjectId: true, role: { select: { key: true } } },
    });
    const byUser = new Map<string, string[]>();
    for (const row of rows) {
      const keys = byUser.get(row.subjectId) ?? [];
      keys.push(row.role.key);
      byUser.set(row.subjectId, keys);
    }
    return byUser;
  };

  const loadMember = async (
    clientUuid: string,
    userId: string,
    context: MembershipContext | null,
  ): Promise<AdminMember | null> => {
    const row = await prisma.clientMembership.findFirst({
      where: { clientId: clientUuid, userId, loginContextId: context?.id ?? null },
      select: MEMBER_SELECT,
    });
    if (row === null) {
      return null;
    }
    const roles = await roleKeysFor(clientUuid, [userId], context?.allowedRoles);
    return toMember(row, roles.get(userId) ?? []);
  };

  const validateAttributes = (
    schema: unknown,
    attributes: Record<string, unknown>,
  ): MemberResult<null> => {
    if (schema !== null && schema !== undefined && !isPlainObject(schema)) {
      return {
        ok: false,
        reason: 'invalid-attributes',
        detail: 'client membership schema is not an object',
      };
    }
    const problems = validateMembershipAttributes(
      schema === undefined ? null : (schema as Record<string, unknown> | null),
      attributes,
    );
    return problems.length === 0
      ? { ok: true, value: null }
      : { ok: false, reason: 'invalid-attributes', detail: problems.join('; ') };
  };

  /** A role assigned through the membership API must belong to this app. */
  const resolveRoles = async (clientId: string, keys: string[]) => {
    const unique = [...new Set(keys)];
    if (unique.length === 0) {
      return { ok: true as const, roles: [] as { id: string; key: string }[] };
    }
    const rows = await prisma.role.findMany({
      where: { key: { in: unique } },
      select: { id: true, key: true, client: { select: { clientId: true } } },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const missing = unique.filter((key) => !byKey.has(key));
    if (missing.length > 0) {
      return {
        ok: false as const,
        reason: 'unknown-role' as const,
        detail: `unknown role(s): ${missing.join(', ')}`,
      };
    }
    const foreign = rows.filter((row) => row.client?.clientId !== clientId);
    if (foreign.length > 0) {
      return {
        ok: false as const,
        reason: 'cross-client-role' as const,
        detail: `role(s) do not belong to client "${clientId}": ${foreign
          .map((row) => row.key)
          .join(', ')}`,
      };
    }
    return { ok: true as const, roles: rows.map((row) => ({ id: row.id, key: row.key })) };
  };

  const roleNotAllowed = (
    roleKeys: readonly string[],
    context: MembershipContext,
  ): MemberResult<never> | null => {
    const problems = contextRoleProblems(roleKeys, context.allowedRoles);
    return problems.length === 0 ? null : failure('role-not-allowed', problems.join('; '));
  };

  /**
   * `default_roles` of a context are applied on its first membership
   * (docs/domain-model.md 3.3). The policy is validated when the context is written; a
   * stale row must not make an invite impossible, so unknown entries are skipped.
   */
  const defaultRoleIdsFor = async (
    clientId: string,
    context: MembershipContext,
  ): Promise<string[]> => {
    if (context.defaultRoles.length === 0) {
      return [];
    }
    const resolved = await resolveRoles(clientId, context.defaultRoles);
    return resolved.ok ? resolved.roles.map((role) => role.id) : [];
  };

  const assignRoles = async (userId: string, roleIds: string[], assignedBy: string) => {
    if (roleIds.length === 0) {
      return;
    }
    const existing = await prisma.assignment.findMany({
      where: {
        subjectType: 'user',
        subjectId: userId,
        roleId: { in: roleIds },
        scopeType: 'global',
        scopeId: null,
      },
      select: { roleId: true },
    });
    const held = new Set(existing.map((row) => row.roleId));
    const missing = roleIds.filter((roleId) => !held.has(roleId));
    if (missing.length > 0) {
      await prisma.assignment.createMany({
        data: missing.map((roleId) => ({
          subjectType: 'user',
          subjectId: userId,
          roleId,
          scopeType: 'global',
          scopeId: null,
          assignedBy,
        })),
        skipDuplicates: true,
      });
    }
  };

  const uniqueUsername = async (tenantId: string, base: string): Promise<string> => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await prisma.user.findUnique({
        where: { tenantId_username: { tenantId, username: candidate } },
        select: { id: true },
      });
      if (taken === null) {
        return candidate;
      }
    }
    return `${base}-${randomBytes(4).toString('hex')}`;
  };

  return {
    async list(clientId: string, query: ListMembersQuery, scope?: MemberScope) {
      const resolved = await resolveScope(clientId, scope);
      if (!resolved.ok) {
        return null;
      }
      const { client, context } = resolved;
      const where = {
        clientId: client.id,
        loginContextId: context?.id ?? null,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.query === undefined
          ? {}
          : {
              user: {
                OR: [
                  { email: { contains: query.query, mode: 'insensitive' as const } },
                  { username: { contains: query.query, mode: 'insensitive' as const } },
                  { displayName: { contains: query.query, mode: 'insensitive' as const } },
                ],
              },
            }),
      };
      const [rows, total] = await Promise.all([
        prisma.clientMembership.findMany({
          where,
          select: MEMBER_SELECT,
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        prisma.clientMembership.count({ where }),
      ]);
      const roles = await roleKeysFor(
        client.id,
        rows.map((row) => row.user.id),
        context?.allowedRoles,
      );
      return {
        items: rows.map((row) => toMember(row, roles.get(row.user.id) ?? [])),
        total,
      };
    },

    async find(clientId, userId, scope) {
      const resolved = await resolveScope(clientId, scope);
      if (!resolved.ok) {
        return null;
      }
      return loadMember(resolved.client.id, userId, resolved.context);
    },

    async invite(clientId: string, input: InviteMemberInput, scope?: MemberScope) {
      const resolved = await resolveScope(clientId, scope);
      if (!resolved.ok) {
        return failure(resolved.reason, resolved.detail);
      }
      const { client, context } = resolved;

      const attributeCheck = validateAttributes(client.membershipSchema, input.attributes);
      if (!attributeCheck.ok) {
        return attributeCheck;
      }

      const roleCheck = await resolveRoles(clientId, input.roleKeys);
      if (!roleCheck.ok) {
        return roleCheck;
      }

      if (context !== null) {
        const denied = roleNotAllowed(input.roleKeys, context);
        if (denied !== null) {
          return denied;
        }
      }

      const email = normalizeEmail(input.email);
      const existingUser = await prisma.user.findFirst({
        where: { tenantId: client.tenantId, email, deletedAt: null },
        select: { id: true },
      });

      let userId: string;
      let createdUser = false;
      if (existingUser === null) {
        const username = await uniqueUsername(client.tenantId, usernameFromEmail(email));
        userId = (
          await prisma.user.create({
            data: {
              tenantId: client.tenantId,
              username,
              email,
              displayName: input.displayName ?? username,
              status: 'pending',
              mustChangePassword: true,
            },
            select: { id: true },
          })
        ).id;
        createdUser = true;
      } else {
        userId = existingUser.id;
      }

      const duplicateDetail =
        context === null
          ? 'user is already a member of this client'
          : `user is already a member of login context "${context.key}"`;
      const duplicate = await prisma.clientMembership.findFirst({
        where: { clientId: client.id, loginContextId: context?.id ?? null, userId },
        select: { id: true },
      });
      if (duplicate !== null) {
        return failure('duplicate', duplicateDetail);
      }

      const at = now();
      try {
        await prisma.clientMembership.create({
          data: {
            clientId: client.id,
            loginContextId: context?.id ?? null,
            userId,
            status: 'invited',
            attributes: input.attributes as never,
            invitedBy: input.invitedBy,
            invitedAt: at,
          },
          select: { id: true },
        });
      } catch (error) {
        // The NULLS NOT DISTINCT unique index closes the race between the lookup and insert.
        if (isUniqueViolation(error)) {
          return failure('duplicate', duplicateDetail);
        }
        throw error;
      }

      const contextDefaults = context === null ? [] : await defaultRoleIdsFor(clientId, context);
      await assignRoles(
        userId,
        [...roleCheck.roles.map((role) => role.id), ...contextDefaults],
        input.invitedBy,
      );
      if (context === null && options.rbac !== undefined) {
        await options.rbac.assignDefaultRoles({
          clientId,
          userId,
          assignedBy: input.invitedBy,
        });
      }

      const member = await loadMember(client.id, userId, context);
      if (member === null) {
        return failure('not-found', 'membership was not persisted');
      }
      return { ok: true, value: { member, createdUser } };
    },

    async update(clientId: string, userId: string, input: UpdateMemberInput, scope?: MemberScope) {
      const resolved = await resolveScope(clientId, scope);
      if (!resolved.ok) {
        return failure(resolved.reason, resolved.detail);
      }
      const { client, context } = resolved;
      const membership = await prisma.clientMembership.findFirst({
        where: { clientId: client.id, loginContextId: context?.id ?? null, userId },
        select: { id: true, status: true, joinedAt: true },
      });
      if (membership === null) {
        return failure('not-found', 'membership does not exist');
      }

      if (input.attributes !== undefined) {
        const attributeCheck = validateAttributes(client.membershipSchema, input.attributes);
        if (!attributeCheck.ok) {
          return attributeCheck;
        }
      }

      const at = now();
      const status = input.status;
      await prisma.clientMembership.update({
        where: { id: membership.id },
        data: {
          ...(status === undefined ? {} : { status }),
          ...(input.attributes === undefined ? {} : { attributes: input.attributes as never }),
          ...(status === 'active' && membership.joinedAt === null ? { joinedAt: at } : {}),
        },
      });

      if (status === 'suspended') {
        if (context === null) {
          await prisma.refreshToken.updateMany({
            where: { clientId: client.id, userId, revokedAt: null },
            data: { revokedAt: at },
          });
          // Only this app's sessions: the user may still be a member of other apps.
          await prisma.session.updateMany({
            where: { userId, clientId: client.id, revokedAt: null },
            data: { revokedAt: at, revokeReason: 'membership_suspend' },
          });
          await options.sessions?.revokeForUserClient(userId, clientId, 'admin');
        } else {
          // Refresh tokens carry the context they were issued for, so only those are
          // revoked; the same user stays signed in to the other contexts of this app.
          await prisma.refreshToken.updateMany({
            where: {
              clientId: client.id,
              userId,
              loginContext: context.key,
              revokedAt: null,
            },
            data: { revokedAt: at },
          });
          // Sessions now record the context they act in, so revoking this context only cuts
          // the sessions that are currently bound to it; the same user stays signed in to the
          // other contexts of this app (`docs/login-contexts.md` 7.3).
          const revokedSids = await options.sessions?.revokeForUserClientContext?.(
            userId,
            clientId,
            context.key,
            'admin',
          );
          if (revokedSids !== undefined && revokedSids.length > 0) {
            await prisma.session.updateMany({
              where: { id: { in: revokedSids }, revokedAt: null },
              data: { revokedAt: at, revokeReason: 'membership_suspend' },
            });
          }
        }
      }

      const member = await loadMember(client.id, userId, context);
      return member === null
        ? failure('not-found', 'membership does not exist')
        : { ok: true, value: member };
    },

    async remove(clientId: string, userId: string, scope?: MemberScope) {
      const resolved = await resolveScope(clientId, scope);
      if (!resolved.ok) {
        return 'not-found';
      }
      const { client, context } = resolved;
      const membership = await prisma.clientMembership.findFirst({
        where: { clientId: client.id, loginContextId: context?.id ?? null, userId },
        select: { id: true },
      });
      if (membership === null) {
        return 'not-found';
      }

      // A context membership may only remove roles that context could grant. Role
      // assignments are user-level (docs/domain-model.md 2.11), so a role listed by two
      // contexts is shared between them; contexts with disjoint role sets stay independent.
      const removableRoles = await prisma.role.findMany({
        where: {
          clientId: client.id,
          ...(context === null ? {} : { key: { in: context.allowedRoles } }),
        },
        select: { id: true },
      });
      await prisma.$transaction([
        prisma.assignment.deleteMany({
          where: {
            subjectType: 'user',
            subjectId: userId,
            roleId: { in: removableRoles.map((role) => role.id) },
          },
        }),
        prisma.clientMembership.delete({ where: { id: membership.id } }),
      ]);
      return 'deleted';
    },

    async replaceRoles(clientId, userId, roleKeys, assignedBy, scope?: MemberScope) {
      const resolved = await resolveScope(clientId, scope);
      if (!resolved.ok) {
        return failure(resolved.reason, resolved.detail);
      }
      const { client, context } = resolved;
      const membership = await prisma.clientMembership.findFirst({
        where: { clientId: client.id, loginContextId: context?.id ?? null, userId },
        select: { id: true },
      });
      if (membership === null) {
        return failure('not-found', 'membership does not exist');
      }

      const roleCheck = await resolveRoles(clientId, roleKeys);
      if (!roleCheck.ok) {
        return roleCheck;
      }

      if (context !== null) {
        const denied = roleNotAllowed(roleKeys, context);
        if (denied !== null) {
          return denied;
        }
      }

      // Replace only the roles this scope governs: a context cannot strip another context's
      // roles when their `allowed_roles` are disjoint, and the context-less endpoint keeps
      // its client-wide replacement semantics. Shared role keys stay shared by design.
      const governedRoles = await prisma.role.findMany({
        where: {
          clientId: client.id,
          ...(context === null ? {} : { key: { in: context.allowedRoles } }),
        },
        select: { id: true },
      });
      await prisma.assignment.deleteMany({
        where: {
          subjectType: 'user',
          subjectId: userId,
          roleId: { in: governedRoles.map((role) => role.id) },
        },
      });
      await assignRoles(
        userId,
        roleCheck.roles.map((role) => role.id),
        assignedBy,
      );

      const member = await loadMember(client.id, userId, context);
      return member === null
        ? failure('not-found', 'membership does not exist')
        : { ok: true, value: member };
    },

    async listSessions(clientId: string, userId: string): Promise<AdminMemberSession[]> {
      const client = await resolveClient(clientId);
      if (client === null) {
        return [];
      }
      const rows = await prisma.session.findMany({
        where: { clientId: client.id, userId },
        select: {
          id: true,
          createdAt: true,
          lastSeenAt: true,
          idleExpiresAt: true,
          absoluteExpiresAt: true,
          ip: true,
          userAgent: true,
          amr: true,
          acr: true,
          revokedAt: true,
          revokeReason: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        idleExpiresAt: row.idleExpiresAt.toISOString(),
        absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
        ip: row.ip,
        userAgent: row.userAgent,
        amr: row.amr,
        acr: row.acr,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        revokeReason: row.revokeReason,
      }));
    },

    async adminContextScope(clientId: string, userId: string): Promise<ContextAdminScope | null> {
      const client = await resolveClient(clientId);
      if (client === null) {
        return null;
      }
      const rows = await prisma.clientMembership.findMany({
        where: { clientId: client.id, userId, status: 'active' },
        select: { loginContextId: true, loginContext: { select: { key: true } } },
      });
      const memberContexts = new Set(
        rows
          .map((row) => row.loginContext?.key)
          .filter((key): key is string => typeof key === 'string'),
      );
      const clientWide = rows.some((row) => row.loginContextId === null);

      // `docs/login-contexts.md` 8 names one role per context. Such a role is context-bound:
      // being an ordinary member of another context must not extend it, and a client-wide
      // membership must not widen it either. Administration still requires an active
      // membership in the named context, so a suspension removes the scope immediately.
      const at = now();
      const assignments = await prisma.assignment.findMany({
        where: {
          subjectType: 'user',
          subjectId: userId,
          scopeType: 'global',
          OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
          role: { clientId: client.id },
        },
        select: { role: { select: { key: true } } },
      });
      const prefix = `${clientId}:context-admin-`;
      const adminContexts = new Set(
        assignments
          .map((assignment) => assignment.role.key)
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length)),
      );
      if (adminContexts.size > 0) {
        // A context-admin role is context-bound even when the admin currently holds no
        // active membership: the empty array means "no context at all", which denies both
        // the context endpoints and the client-wide surface. Returning `null` here would
        // look like an app-wide caller without a membership and would re-open the
        // client-wide surface after a suspension.
        return [...memberContexts].filter((key) => adminContexts.has(key)).sort();
      }

      // No context-admin role: the caller's app-level role decides, and a client-wide
      // membership administers every context of the app. Context memberships are the only
      // scope source otherwise.
      if (clientWide) {
        return 'all';
      }
      return memberContexts.size === 0 ? null : [...memberContexts].sort();
    },
  };
}
