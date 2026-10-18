import type { PrismaClient } from '../generated/prisma/client.js';
import type { TokenProfile, UserProfileRepository } from './token-claims.js';

/** Reads the identity fields needed to mint ID tokens. */
export function createPrismaUserRepository(prisma: PrismaClient): UserProfileRepository {
  return {
    async findProfile(userId): Promise<TokenProfile | null> {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          email: true,
          emailVerifiedAt: true,
          displayName: true,
          locale: true,
          tenantId: true,
          status: true,
          deletedAt: true,
        },
      });
      if (user === null || user.deletedAt !== null || user.status === 'disabled') {
        return null;
      }
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        emailVerified: user.emailVerifiedAt !== null,
        displayName: user.displayName,
        locale: user.locale,
        tenantId: user.tenantId,
      };
    },
  };
}
