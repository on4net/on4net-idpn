import type { PrismaClient } from '../generated/prisma/client.js';
import type { AccountProfileRepository } from './account-types.js';

/** Prisma-backed profile lookup for `/api/v1/account/profile`. */
export function createPrismaAccountProfileRepository(
  prisma: PrismaClient,
): AccountProfileRepository {
  return {
    async findById(userId) {
      const row = await prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: {
          id: true,
          username: true,
          email: true,
          displayName: true,
          phone: true,
          avatarUrl: true,
          locale: true,
          status: true,
          emailVerifiedAt: true,
          mustChangePassword: true,
          createdAt: true,
          passwordChangedAt: true,
        },
      });
      if (row === null) {
        return null;
      }
      return {
        id: row.id,
        username: row.username,
        email: row.email,
        displayName: row.displayName,
        phone: row.phone,
        avatarUrl: row.avatarUrl,
        locale: row.locale,
        status: row.status,
        emailVerified: row.emailVerifiedAt !== null,
        mustChangePassword: row.mustChangePassword,
        createdAt: row.createdAt.toISOString(),
        passwordChangedAt: row.passwordChangedAt?.toISOString() ?? null,
      };
    },
  };
}
