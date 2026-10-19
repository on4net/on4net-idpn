import { randomBytes } from 'node:crypto';

import type { PrismaClient } from '../../generated/prisma/client.js';
import { normalizeEmail } from '../../auth/normalize.js';
import type { AdminRbacRepository } from '../rbac/rbac-types.js';
import { validateMembershipAttributes } from './member-validation.js';
import type {
  AdminMember,
  AdminMemberRepository,
  AdminMemberSession,
  InviteMemberInput,
  ListMembersQuery,
  MemberResult,
  MembershipStatus,
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

export interface PrismaMemberRepositoryOptions {
  /** Used to apply the client's `is_default` roles on the first membership. */
  rbac?: Pick<AdminRbacRepository, 'assignDefaultRoles'>;
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

  const roleKeysFor = async (clientUuid: string, userIds: string[]) => {
    if (userIds.length === 0) {
      return new Map<string, string[]>();
    }
    const rows = await prisma.assignment.findMany({
      where: {
        subjectType: 'user',
        subjectId: { in: userIds },
        role: { clientId: clientUuid },
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

  const loadMember = async (clientUuid: string, userId: string): Promise<AdminMember | null> => {
    const row = await prisma.clientMembership.findFirst({
      where: { clientId: clientUuid, userId, loginContextId: null },
      select: MEMBER_SELECT,
    });
    if (row === null) {
      return null;
    }
    const roles = await roleKeysFor(clientUuid, [userId]);
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
    async list(clientId: string, query: ListMembersQuery) {
      const client = await resolveClient(clientId);
      if (client === null) {
        return null;
      }
      const where = {
        clientId: client.id,
        loginContextId: null,
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
      );
      return {
        items: rows.map((row) => toMember(row, roles.get(row.user.id) ?? [])),
        total,
      };
    },

    async find(clientId, userId) {
      const client = await resolveClient(clientId);
      if (client === null) {
        return null;
      }
      return loadMember(client.id, userId);
    },

    async invite(clientId: string, input: InviteMemberInput) {
      const client = await resolveClient(clientId);
      if (client === null) {
        return {
          ok: false,
          reason: 'client-not-found',
          detail: `client "${clientId}" does not exist`,
        };
      }

      const attributeCheck = validateAttributes(client.membershipSchema, input.attributes);
      if (!attributeCheck.ok) {
        return attributeCheck;
      }

      const roleCheck = await resolveRoles(clientId, input.roleKeys);
      if (!roleCheck.ok) {
        return roleCheck;
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

      const duplicate = await prisma.clientMembership.findFirst({
        where: { clientId: client.id, loginContextId: null, userId },
        select: { id: true },
      });
      if (duplicate !== null) {
        return {
          ok: false,
          reason: 'duplicate',
          detail: 'user is already a member of this client',
        };
      }

      const at = now();
      await prisma.clientMembership.create({
        data: {
          clientId: client.id,
          userId,
          status: 'invited',
          attributes: input.attributes as never,
          invitedBy: input.invitedBy,
          invitedAt: at,
        },
        select: { id: true },
      });

      await assignRoles(
        userId,
        roleCheck.roles.map((role) => role.id),
        input.invitedBy,
      );
      if (options.rbac !== undefined) {
        await options.rbac.assignDefaultRoles({
          clientId,
          userId,
          assignedBy: input.invitedBy,
        });
      }

      const member = await loadMember(client.id, userId);
      if (member === null) {
        return { ok: false, reason: 'not-found', detail: 'membership was not persisted' };
      }
      return { ok: true, value: { member, createdUser } };
    },

    async update(clientId: string, userId: string, input: UpdateMemberInput) {
      const client = await resolveClient(clientId);
      if (client === null) {
        return {
          ok: false,
          reason: 'client-not-found',
          detail: `client "${clientId}" does not exist`,
        };
      }
      const membership = await prisma.clientMembership.findFirst({
        where: { clientId: client.id, loginContextId: null, userId },
        select: { id: true, status: true, joinedAt: true },
      });
      if (membership === null) {
        return { ok: false, reason: 'not-found', detail: 'membership does not exist' };
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
        await prisma.refreshToken.updateMany({
          where: { clientId: client.id, userId, revokedAt: null },
          data: { revokedAt: at },
        });
      }

      const member = await loadMember(client.id, userId);
      return member === null
        ? { ok: false, reason: 'not-found', detail: 'membership does not exist' }
        : { ok: true, value: member };
    },

    async remove(clientId: string, userId: string) {
      const client = await resolveClient(clientId);
      if (client === null) {
        return 'not-found';
      }
      const membership = await prisma.clientMembership.findFirst({
        where: { clientId: client.id, loginContextId: null, userId },
        select: { id: true },
      });
      if (membership === null) {
        return 'not-found';
      }

      const clientRoles = await prisma.role.findMany({
        where: { clientId: client.id },
        select: { id: true },
      });
      await prisma.$transaction([
        prisma.assignment.deleteMany({
          where: {
            subjectType: 'user',
            subjectId: userId,
            roleId: { in: clientRoles.map((role) => role.id) },
          },
        }),
        prisma.clientMembership.delete({ where: { id: membership.id } }),
      ]);
      return 'deleted';
    },

    async replaceRoles(clientId, userId, roleKeys, assignedBy) {
      const client = await resolveClient(clientId);
      if (client === null) {
        return {
          ok: false,
          reason: 'client-not-found',
          detail: `client "${clientId}" does not exist`,
        };
      }
      const membership = await prisma.clientMembership.findFirst({
        where: { clientId: client.id, loginContextId: null, userId },
        select: { id: true },
      });
      if (membership === null) {
        return { ok: false, reason: 'not-found', detail: 'membership does not exist' };
      }

      const roleCheck = await resolveRoles(clientId, roleKeys);
      if (!roleCheck.ok) {
        return roleCheck;
      }

      const clientRoles = await prisma.role.findMany({
        where: { clientId: client.id },
        select: { id: true },
      });
      await prisma.assignment.deleteMany({
        where: {
          subjectType: 'user',
          subjectId: userId,
          roleId: { in: clientRoles.map((role) => role.id) },
        },
      });
      await assignRoles(
        userId,
        roleCheck.roles.map((role) => role.id),
        assignedBy,
      );

      const member = await loadMember(client.id, userId);
      return member === null
        ? { ok: false, reason: 'not-found', detail: 'membership does not exist' }
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
  };
}
