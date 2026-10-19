import type { PrismaClient } from '../generated/prisma/client.js';
import { normalizeEmail } from '../auth/normalize.js';
import type { LifecycleUser, LifecycleUserStore } from './lifecycle.js';

const USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  locale: true,
  status: true,
  passwordHash: true,
  emailVerifiedAt: true,
  deletedAt: true,
} as const;

const toUser = (row: {
  id: string;
  email: string;
  displayName: string;
  locale: string;
  status: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  deletedAt: Date | null;
}): LifecycleUser => ({
  id: row.id,
  email: row.email,
  displayName: row.displayName,
  locale: row.locale,
  status: row.status as LifecycleUser['status'],
  passwordHash: row.passwordHash,
  emailVerifiedAt: row.emailVerifiedAt,
  deletedAt: row.deletedAt,
});

/** Prisma-backed lookups used by invite, verification and reset flows. */
export function createPrismaLifecycleUserStore(prisma: PrismaClient): LifecycleUserStore {
  return {
    async findById(userId) {
      const row = await prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT });
      return row === null ? null : toUser(row);
    },

    async findByEmail(email) {
      const row = await prisma.user.findFirst({
        where: { email: normalizeEmail(email), deletedAt: null },
        select: USER_SELECT,
        orderBy: { createdAt: 'asc' },
      });
      return row === null ? null : toUser(row);
    },

    async markEmailVerified(userId, at) {
      await prisma.user.updateMany({
        where: { id: userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: at },
      });
    },

    async activatePendingUser(userId, at) {
      await prisma.user.updateMany({
        where: { id: userId, status: 'pending' },
        data: { status: 'active', updatedAt: at },
      });
    },

    async activateInvitedMemberships(userId, at) {
      const result = await prisma.clientMembership.updateMany({
        where: { userId, status: 'invited' },
        data: { status: 'active', joinedAt: at },
      });
      return result.count;
    },
  };
}
