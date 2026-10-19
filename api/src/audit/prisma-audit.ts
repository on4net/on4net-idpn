import { sanitizeAuditMetadata, type AuditEventInput } from './sanitize.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { SessionRevoker } from '../session/revocation.js';
import type { PasswordStore } from '../users/change-password.js';
/** Persists an audit event with credentials stripped from metadata. */
export async function recordAuditEvent(
  prisma: PrismaClient,
  event: AuditEventInput,
): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      actorType: event.actorType,
      actorId: event.actorId ?? null,
      action: event.action,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      clientId: event.clientId ?? null,
      ip: event.ip ?? null,
      userAgent: event.userAgent ?? null,
      result: event.result,
      metadata: sanitizeAuditMetadata(event.metadata) as never,
    },
  });
}

/**
 * Prisma-backed implementation of the password change workflow.
 *
 * `sessions` must be supplied in production so a password change also invalidates the Redis
 * sessions that `/oauth2/authorize` and refresh grants read (the database row alone is not
 * enough to reject the next request).
 */
export function createPrismaPasswordStore(
  prisma: PrismaClient,
  options: {
    sessions?: Pick<SessionRevoker, 'revokeAllForUser'> &
      Partial<Pick<SessionRevoker, 'revokeAllForUserExcept'>>;
  } = {},
): PasswordStore {
  return {
    async findUser(userId) {
      return prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          username: true,
          displayName: true,
          passwordHash: true,
          status: true,
          deletedAt: true,
        },
      });
    },

    async updatePassword(userId, passwordHash, changedAt) {
      await prisma.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: changedAt, mustChangePassword: false },
      });
    },

    async revokeSessions(userId, revokedAt, reason, revokeOptions) {
      const keepSessionId = revokeOptions?.keepSessionId;
      const result = await prisma.session.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(keepSessionId === undefined ? {} : { id: { not: keepSessionId } }),
        },
        data: { revokedAt, revokeReason: reason },
      });
      if (keepSessionId !== undefined && options.sessions?.revokeAllForUserExcept !== undefined) {
        await options.sessions.revokeAllForUserExcept(userId, keepSessionId, 'password_change');
      } else {
        await options.sessions?.revokeAllForUser(userId, 'password_change');
      }
      return result.count;
    },

    async revokeRefreshTokens(userId, revokedAt, revokeOptions) {
      const keepSessionId = revokeOptions?.keepSessionId;
      const result = await prisma.refreshToken.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(keepSessionId === undefined ? {} : { sessionId: { not: keepSessionId } }),
        },
        data: { revokedAt },
      });
      return result.count;
    },

    async recordAudit(event) {
      await recordAuditEvent(prisma, event);
    },
  };
}
