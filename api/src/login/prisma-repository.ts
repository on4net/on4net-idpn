import type { PrismaClient } from '../generated/prisma/client.js';
import { recordAuditEvent } from '../audit/prisma-audit.js';
import type { LoginUserRecord, LoginUserRepository } from './login-types.js';

/** Prisma-backed login lookups: identifier resolution, lock counters and last-login time. */
export function createPrismaLoginRepository(prisma: PrismaClient): LoginUserRepository & {
  record(event: Parameters<typeof recordAuditEvent>[1]): Promise<void>;
  persistSession(input: {
    sid: string;
    userId: string;
    tenantId: string;
    ip?: string;
    userAgent?: string;
    amr: string[];
    acr: string;
    createdAt: Date;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<void>;
} {
  return {
    async persistSession(input) {
      await prisma.session.create({
        data: {
          id: input.sid,
          userId: input.userId,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          amr: input.amr,
          acr: input.acr,
          createdAt: input.createdAt,
          lastSeenAt: input.createdAt,
          idleExpiresAt: input.idleExpiresAt,
          absoluteExpiresAt: input.absoluteExpiresAt,
        },
      });
    },

    async findByIdentifier(normalizedIdentifier): Promise<LoginUserRecord | null> {
      const user = await prisma.user.findFirst({
        where: {
          deletedAt: null,
          OR: [{ email: normalizedIdentifier }, { username: normalizedIdentifier }],
        },
        select: {
          id: true,
          tenantId: true,
          username: true,
          email: true,
          displayName: true,
          locale: true,
          status: true,
          passwordHash: true,
          lockedUntil: true,
          failedLoginCount: true,
          deletedAt: true,
        },
      });
      return user ?? null;
    },

    async registerFailedAttempt(userId, attempts, lockedUntil) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: attempts,
          ...(lockedUntil === null ? {} : { lockedUntil, status: 'locked' }),
        },
      });
    },

    async registerSuccessfulLogin(userId, at) {
      await prisma.user.update({
        where: { id: userId },
        data: { lastLoginAt: at, failedLoginCount: 0, lockedUntil: null },
      });
    },

    async record(event) {
      await recordAuditEvent(prisma, event);
    },
  };
}
