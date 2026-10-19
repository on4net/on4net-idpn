import type { PrismaClient } from '../generated/prisma/client.js';
import type { PermissionReader } from './authorize.js';

/**
 * Resolves the permissions a user holds through **global** role assignments.
 *
 * App-scoped assignments (`scopeType = client`) are deliberately excluded: they belong to the
 * Delegated Admin surface. Expired assignments are ignored.
 */
export function createPrismaPermissionReader(
  prisma: PrismaClient,
  now: () => Date = () => new Date(),
): PermissionReader {
  return {
    async globalPermissionsForUser(userId) {
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
  };
}
