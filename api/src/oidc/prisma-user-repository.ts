import type { PrismaClient } from '../generated/prisma/client.js';
import type { UserProfileSource } from './userinfo-route.js';
import type { TokenProfile, UserProfileRepository } from './token-claims.js';

export interface UserInfoRepository {
  findUserInfoProfile(userId: string): Promise<UserProfileSource | null>;
}

/** Reads the identity fields needed to mint ID tokens and answer userinfo. */
export function createPrismaUserRepository(
  prisma: PrismaClient,
): UserProfileRepository & UserInfoRepository {
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

    async findUserInfoProfile(userId): Promise<UserProfileSource | null> {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          username: true,
          email: true,
          emailVerifiedAt: true,
          displayName: true,
          locale: true,
          avatarUrl: true,
          phone: true,
          phoneVerifiedAt: true,
          status: true,
          deletedAt: true,
        },
      });
      if (user === null || user.deletedAt !== null || user.status === 'disabled') {
        return null;
      }
      return {
        username: user.username,
        email: user.email,
        emailVerified: user.emailVerifiedAt !== null,
        displayName: user.displayName,
        locale: user.locale,
        avatarUrl: user.avatarUrl,
        phone: user.phone,
        phoneVerified: user.phoneVerifiedAt !== null,
      };
    },
  };
}
