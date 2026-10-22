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
 * enough to reject the next request). The Redis revocation happens **before** the write
 * transaction: nothing is written when it fails, so the password and the live sessions can
 * never disagree.
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

    async revokeLiveSessions(userId, revokeReason, revokeOptions) {
      const keepSessionId = revokeOptions?.keepSessionId;
      if (keepSessionId !== undefined && options.sessions?.revokeAllForUserExcept !== undefined) {
        await options.sessions.revokeAllForUserExcept(userId, keepSessionId, revokeReason);
        return;
      }
      await options.sessions?.revokeAllForUser(userId, revokeReason);
    },

    async commitPasswordChange(commit) {
      const keepSessionId = commit.keepSessionId;
      const [, sessions, refreshTokens] = await prisma.$transaction([
        prisma.user.update({
          where: { id: commit.userId },
          data: {
            passwordHash: commit.passwordHash,
            passwordChangedAt: commit.changedAt,
            mustChangePassword: false,
          },
        }),
        prisma.session.updateMany({
          where: {
            userId: commit.userId,
            revokedAt: null,
            ...(keepSessionId === undefined ? {} : { id: { not: keepSessionId } }),
          },
          data: { revokedAt: commit.changedAt, revokeReason: commit.reason },
        }),
        prisma.refreshToken.updateMany({
          where: {
            userId: commit.userId,
            revokedAt: null,
            ...(keepSessionId === undefined ? {} : { sessionId: { not: keepSessionId } }),
          },
          data: { revokedAt: commit.changedAt },
        }),
      ]);
      return { revokedSessions: sessions.count, revokedRefreshTokens: refreshTokens.count };
    },

    async recordAudit(event) {
      await recordAuditEvent(prisma, event);
    },
  };
}
