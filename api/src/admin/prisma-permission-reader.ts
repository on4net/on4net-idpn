import type { PrismaClient } from '../generated/prisma/client.js';
import { isClientScopedPermission, type PermissionReader } from './authorize.js';

/**
 * Resolves the permissions a user holds through **global** role assignments.
 *
 * App-scoped assignments (`scopeType = client`) are deliberately excluded: they belong to the
 * Delegated Admin surface. Expired assignments are ignored.
 *
 * A user who is not `active` (disabled, locked, pending or soft-deleted) resolves to an empty
 * set, so a token issued before the account was disabled stops working immediately instead of
 * waiting for the access token to expire.
 */
export function createPrismaPermissionReader(
  prisma: PrismaClient,
  now: () => Date = () => new Date(),
): PermissionReader {
  const isActiveUser = async (userId: string): Promise<boolean> => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, deletedAt: true },
    });
    return user !== null && user.status === 'active' && user.deletedAt === null;
  };

  const activeAssignment = (userId: string, at: Date) => ({
    subjectType: 'user' as const,
    subjectId: userId,
    scopeType: 'global' as const,
    OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
  });

  return {
    async globalPermissionsForUser(userId) {
      if (!(await isActiveUser(userId))) {
        return [];
      }
      const at = now();
      const rows = await prisma.rolePermission.findMany({
        where: {
          role: {
            assignments: {
              some: {
                subjectType: 'user',
                subjectId: userId,
                scopeType: 'global',
                OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
              },
            },
          },
        },
        select: { permission: { select: { key: true } } },
      });
      return [...new Set(rows.map((row) => row.permission.key))];
    },

    async clientPermissionsForUser(userId, clientId) {
      if (!(await isActiveUser(userId))) {
        return [];
      }
      const at = now();
      const rows = await prisma.rolePermission.findMany({
        where: {
          role: {
            assignments: { some: activeAssignment(userId, at) },
            OR: [{ clientId: null }, { client: { clientId } }],
          },
          permission: { OR: [{ clientId: null }, { client: { clientId } }] },
        },
        select: { permission: { select: { key: true } } },
      });
      return [
        ...new Set(
          rows.map((row) => row.permission.key).filter((key) => isClientScopedPermission(key)),
        ),
      ];
    },
  };
}
