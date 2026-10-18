import { sanitizeAuditMetadata, type AuditEventInput } from './sanitize.js';
import type { PrismaClient } from '../generated/prisma/client.js';
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

/** Prisma-backed implementation of the password change workflow. */
export function createPrismaPasswordStore(prisma: PrismaClient): PasswordStore {
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

    async revokeSessions(userId, revokedAt, reason) {
      const result = await prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt, revokeReason: reason },
      });
      return result.count;
    },

    async revokeRefreshTokens(userId, revokedAt) {
      const result = await prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt },
      });
      return result.count;
    },

    async recordAudit(event) {
      await recordAuditEvent(prisma, event);
    },
  };
}
