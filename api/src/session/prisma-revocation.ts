import type { PrismaClient } from '../generated/prisma/client.js';
import { recordAuditEvent } from '../audit/prisma-audit.js';
import type { SessionRevocationHook } from './revocation.js';

/**
 * Mirrors store-initiated revocations into PostgreSQL and the audit trail.
 *
 * Only the concurrent-session limit is handled here: every other revocation is initiated by
 * a route that already updates both stores and records its own audit event.
 */
export function createPrismaSessionRevocationHook(prisma: PrismaClient): SessionRevocationHook {
  return async (session, reason) => {
    if (reason !== 'concurrent_limit') {
      return;
    }
    const revokedAt = session.revokedAt === undefined ? new Date() : new Date(session.revokedAt);
    await prisma.session.updateMany({
      where: { id: session.sid, revokedAt: null },
      data: { revokedAt, revokeReason: reason },
    });
    await prisma.refreshToken.updateMany({
      where: { sessionId: session.sid, revokedAt: null },
      data: { revokedAt },
    });
    await recordAuditEvent(prisma, {
      actorType: 'system',
      action: 'session.revoke',
      targetType: 'session',
      targetId: session.sid,
      result: 'success',
      metadata: { userId: session.userId, reason },
    });
  };
}
