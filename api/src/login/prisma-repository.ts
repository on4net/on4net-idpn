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
    /** Public client id that started the login; resolved to its UUID for the foreign key. */
    clientId?: string;
    /** Login Context the session was established for (null/omitted = client-wide). */
    loginContext?: string;
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
      const client =
        input.clientId === undefined || input.clientId === ''
          ? null
          : await prisma.client.findUnique({
              where: { clientId: input.clientId },
              select: { id: true },
            });
      await prisma.session.create({
        data: {
          id: input.sid,
          userId: input.userId,
          clientId: client?.id ?? null,
          loginContext: input.loginContext ?? null,
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
      // Users are unique per tenant, so the same identifier can exist in several tenants. The
      // login form does not carry a tenant yet (single-tenant phase 1): resolve nothing rather
      // than authenticate against an arbitrary tenant.
      const users = await prisma.user.findMany({
        where: {
          deletedAt: null,
          OR: [{ email: normalizedIdentifier }, { username: normalizedIdentifier }],
        },
        take: 2,
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
      return users.length === 1 ? (users[0] ?? null) : null;
    },

    async registerFailedAttempt(userId, attempts, lockedUntil) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: attempts,
          // The lock lives in `locked_until` only. Writing `status = 'locked'` made the lock
          // permanent, because the login route refuses any non-active account.
          ...(lockedUntil === null ? {} : { lockedUntil }),
        },
      });
    },

    async registerSuccessfulLogin(userId, at) {
      await prisma.user.update({
        where: { id: userId },
        data: { lastLoginAt: at, failedLoginCount: 0, lockedUntil: null },
      });
    },

    async rehashPassword(userId, passwordHash) {
      await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    },

    async record(event) {
      await recordAuditEvent(prisma, event);
    },
  };
}
