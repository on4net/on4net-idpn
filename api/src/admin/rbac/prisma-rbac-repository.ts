import type { PrismaClient } from '../../generated/prisma/client.js';
import { permissionOwnershipProblem } from './rbac-validation.js';
import type {
  AdminPermission,
  AdminRbacRepository,
  AdminRole,
  CatalogResult,
  CreatePermissionInput,
  CreateRoleInput,
  ListCatalogQuery,
  UpdateRoleInput,
} from './rbac-types.js';

interface PermissionRow {
  id: string;
  key: string;
  description: string;
  client: { clientId: string } | null;
}

interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  client: { clientId: string } | null;
  rolePermissions: { permission: { key: string } }[];
}

const PERMISSION_SELECT = {
  id: true,
  key: true,
  description: true,
  client: { select: { clientId: true } },
} as const;

const ROLE_SELECT = {
  id: true,
  key: true,
  name: true,
  description: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
  client: { select: { clientId: true } },
  rolePermissions: { select: { permission: { select: { key: true } } } },
} as const;

const toPermission = (row: PermissionRow): AdminPermission => ({
  id: row.id,
  key: row.key,
  clientId: row.client?.clientId ?? null,
  description: row.description,
});

const toRole = (row: RoleRow): AdminRole => ({
  id: row.id,
  key: row.key,
  name: row.name,
  description: row.description,
  clientId: row.client?.clientId ?? null,
  isDefault: row.isDefault,
  permissionKeys: row.rolePermissions.map((entry) => entry.permission.key).sort(),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

const isMissingRecord = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2025';

/** Prisma-backed permission catalog and role repository. */
export function createPrismaRbacRepository(prisma: PrismaClient): AdminRbacRepository {
  const resolveClient = async (clientId: string): Promise<string | null> => {
    const row = await prisma.client.findUnique({
      where: { clientId },
      select: { id: true },
    });
    return row?.id ?? null;
  };

  const loadRole = async (roleId: string): Promise<AdminRole | null> => {
    const row = await prisma.role.findUnique({
      where: { id: roleId },
      select: ROLE_SELECT,
    });
    return row === null ? null : toRole(row);
  };

  /**
   * Resolves permission keys and verifies that every key may be linked to a role of the
   * given client. Global permissions are allowed; a different client's permission is not.
   */
  const linkablePermissions = async (
    keys: string[],
    roleClientId: string | null,
  ): Promise<CatalogResult<{ id: string }[]>> => {
    const unique = [...new Set(keys)];
    if (unique.length === 0) {
      return { ok: true, value: [] };
    }

    const rows = await prisma.permission.findMany({
      where: { key: { in: unique } },
      select: { id: true, key: true, client: { select: { clientId: true } } },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const missing = unique.filter((key) => !byKey.has(key));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: 'unknown-permission',
        detail: `unknown permission(s): ${missing.join(', ')}`,
      };
    }

    for (const row of rows) {
      const problem = permissionOwnershipProblem(row.client?.clientId ?? null, roleClientId);
      if (problem !== null) {
        return { ok: false, reason: 'cross-client-permission', detail: problem };
      }
    }

    return { ok: true, value: rows.map((row) => ({ id: row.id })) };
  };

  return {
    async listPermissions(input: ListCatalogQuery) {
      const where = {
        ...(input.clientId === undefined ? {} : { client: { clientId: input.clientId } }),
        ...(input.query === undefined
          ? {}
          : {
              OR: [
                { key: { contains: input.query, mode: 'insensitive' as const } },
                { description: { contains: input.query, mode: 'insensitive' as const } },
              ],
            }),
      };
      const [rows, total] = await Promise.all([
        prisma.permission.findMany({
          where,
          select: PERMISSION_SELECT,
          orderBy: { key: 'asc' },
          skip: (input.page - 1) * input.limit,
          take: input.limit,
        }),
        prisma.permission.count({ where }),
      ]);
      return { items: rows.map(toPermission), total };
    },

    async createPermission(input: CreatePermissionInput) {
      const clientUuid = input.clientId === null ? null : await resolveClient(input.clientId);
      if (input.clientId !== null && clientUuid === null) {
        return {
          ok: false,
          reason: 'client-not-found',
          detail: `client "${input.clientId}" does not exist`,
        };
      }

      try {
        const row = await prisma.permission.create({
          data: {
            key: input.key,
            description: input.description,
            clientId: clientUuid,
          },
          select: PERMISSION_SELECT,
        });
        return { ok: true, value: toPermission(row) };
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { ok: false, reason: 'duplicate-key', detail: `permission "${input.key}" exists` };
        }
        throw error;
      }
    },

    async deletePermission(permissionId: string) {
      const permission = await prisma.permission.findUnique({
        where: { id: permissionId },
        select: { id: true },
      });
      if (permission === null) {
        return 'not-found';
      }
      const links = await prisma.rolePermission.count({ where: { permissionId } });
      if (links > 0) {
        return 'in-use';
      }
      await prisma.permission.delete({ where: { id: permissionId } });
      return 'deleted';
    },

    async listRoles(input: ListCatalogQuery) {
      const where = {
        ...(input.clientId === undefined ? {} : { client: { clientId: input.clientId } }),
        ...(input.query === undefined
          ? {}
          : {
              OR: [
                { key: { contains: input.query, mode: 'insensitive' as const } },
                { name: { contains: input.query, mode: 'insensitive' as const } },
                { description: { contains: input.query, mode: 'insensitive' as const } },
              ],
            }),
      };
      const [rows, total] = await Promise.all([
        prisma.role.findMany({
          where,
          select: ROLE_SELECT,
          orderBy: { key: 'asc' },
          skip: (input.page - 1) * input.limit,
          take: input.limit,
        }),
        prisma.role.count({ where }),
      ]);
      return { items: rows.map(toRole), total };
    },

    findRole: loadRole,

    async createRole(input: CreateRoleInput) {
      const clientUuid = input.clientId === null ? null : await resolveClient(input.clientId);
      if (input.clientId !== null && clientUuid === null) {
        return {
          ok: false,
          reason: 'client-not-found',
          detail: `client "${input.clientId}" does not exist`,
        };
      }

      const linked = await linkablePermissions(input.permissionKeys, input.clientId);
      if (!linked.ok) {
        return linked;
      }

      try {
        const row = await prisma.role.create({
          data: {
            key: input.key,
            name: input.name,
            description: input.description,
            clientId: clientUuid,
            isDefault: input.isDefault,
            rolePermissions: { create: linked.value.map((entry) => ({ permissionId: entry.id })) },
          },
          select: ROLE_SELECT,
        });
        return { ok: true, value: toRole(row) };
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { ok: false, reason: 'duplicate-key', detail: `role "${input.key}" exists` };
        }
        throw error;
      }
    },

    async updateRole(roleId: string, input: UpdateRoleInput) {
      try {
        const row = await prisma.role.update({
          where: { id: roleId },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
          },
          select: ROLE_SELECT,
        });
        return { ok: true, value: toRole(row) };
      } catch (error) {
        if (isMissingRecord(error)) {
          return { ok: false, reason: 'not-found', detail: 'role does not exist' };
        }
        throw error;
      }
    },

    async replaceRolePermissions(roleId: string, permissionKeys: string[]) {
      const role = await prisma.role.findUnique({
        where: { id: roleId },
        select: { id: true, client: { select: { clientId: true } } },
      });
      if (role === null) {
        return { ok: false, reason: 'not-found', detail: 'role does not exist' };
      }

      const roleClientId = role.client?.clientId ?? null;
      const linked = await linkablePermissions(permissionKeys, roleClientId);
      if (!linked.ok) {
        return linked;
      }

      await prisma.$transaction([
        prisma.rolePermission.deleteMany({ where: { roleId } }),
        prisma.rolePermission.createMany({
          data: linked.value.map((entry) => ({ roleId, permissionId: entry.id })),
        }),
      ]);

      const updated = await loadRole(roleId);
      return updated === null
        ? { ok: false, reason: 'not-found', detail: 'role does not exist' }
        : { ok: true, value: updated };
    },

    async deleteRole(roleId: string) {
      const role = await prisma.role.findUnique({
        where: { id: roleId },
        select: { id: true },
      });
      if (role === null) {
        return 'not-found';
      }
      const assignments = await prisma.assignment.count({ where: { roleId } });
      if (assignments > 0) {
        return 'in-use';
      }
      await prisma.$transaction([
        prisma.rolePermission.deleteMany({ where: { roleId } }),
        prisma.role.delete({ where: { id: roleId } }),
      ]);
      return 'deleted';
    },

    async assignDefaultRoles({ clientId, userId, assignedBy }) {
      const clientUuid = await resolveClient(clientId);
      if (clientUuid === null) {
        return [];
      }
      const roles = await prisma.role.findMany({
        where: { clientId: clientUuid, isDefault: true },
        select: { id: true, key: true },
      });
      if (roles.length === 0) {
        return [];
      }
      const existing = await prisma.assignment.findMany({
        where: {
          subjectType: 'user',
          subjectId: userId,
          roleId: { in: roles.map((role) => role.id) },
          scopeType: 'global',
          scopeId: null,
        },
        select: { roleId: true },
      });
      const held = new Set(existing.map((row) => row.roleId));
      const missing = roles.filter((role) => !held.has(role.id));
      if (missing.length > 0) {
        await prisma.assignment.createMany({
          data: missing.map((role) => ({
            subjectType: 'user',
            subjectId: userId,
            roleId: role.id,
            scopeType: 'global',
            scopeId: null,
            assignedBy,
          })),
          skipDuplicates: true,
        });
      }
      return roles.map((role) => role.key).sort();
    },
  };
}
