import type { PrismaClient } from '../generated/prisma/client.js';
import type { BackchannelLogoutParticipant } from './backchannel-logout.js';
import type { LogoutRevocationStore } from './logout-route.js';

const clientSelection = {
  clientId: true,
  backchannelLogoutUri: true,
  status: true,
} as const;

/**
 * Logout persistence.
 *
 * Participants are every active client that is demonstrably part of the session:
 * the client recorded on the session itself, plus each client that holds an authorization
 * code or a refresh token for that `sid`. Deriving from the database (not from a request
 * parameter) means a client cannot ask to be notified for someone else's session.
 */
export function createPrismaLogoutRepository(prisma: PrismaClient): LogoutRevocationStore {
  return {
    async findParticipants(sessionId) {
      const [session, codes, tokens] = await Promise.all([
        prisma.session.findUnique({
          where: { id: sessionId },
          select: { client: { select: clientSelection } },
        }),
        prisma.authorizationCode.findMany({
          where: { sessionId },
          select: { client: { select: clientSelection } },
        }),
        prisma.refreshToken.findMany({
          where: { sessionId },
          select: { client: { select: clientSelection } },
        }),
      ]);

      const participants = new Map<string, BackchannelLogoutParticipant>();
      const add = (
        client: {
          clientId: string;
          backchannelLogoutUri: string | null;
          status: 'active' | 'disabled';
        } | null,
      ): void => {
        if (client === null || client.status !== 'active') {
          return;
        }
        participants.set(client.clientId, {
          clientId: client.clientId,
          backchannelLogoutUri: client.backchannelLogoutUri,
        });
      };

      add(session?.client ?? null);
      for (const row of codes) {
        add(row.client);
      }
      for (const row of tokens) {
        add(row.client);
      }

      return [...participants.values()].sort((a, b) => a.clientId.localeCompare(b.clientId));
    },

    async revokeSession(sessionId, revokedAt, reason) {
      const result = await prisma.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt, revokeReason: reason },
      });
      return result.count > 0;
    },

    async revokeRefreshTokens(sessionId, revokedAt) {
      const result = await prisma.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt },
      });
      return result.count;
    },
  };
}
