import type { PrismaClient } from '../generated/prisma/client.js';
import type { IdpSession } from './types.js';

/**
 * Mirrors the idle-timeout slide of a Redis session into PostgreSQL.
 *
 * The Redis store is authoritative and slides `idle_expires_at` on every read; the mirror is
 * what the Admin API lists and what the `idpn_active_sessions` gauge counts. Without this
 * write-behind the row keeps the creation-time expiry, so a session that is still in use
 * looks expired after the first idle window. The store throttles the calls per `sid`.
 */
export function createPrismaSessionSlideMirror(
  prisma: PrismaClient,
): (session: IdpSession) => Promise<void> {
  return async (session) => {
    await prisma.session.updateMany({
      where: { id: session.sid, revokedAt: null },
      data: {
        lastSeenAt: new Date(session.lastSeenAt),
        idleExpiresAt: new Date(session.idleExpiresAt),
      },
    });
  };
}
