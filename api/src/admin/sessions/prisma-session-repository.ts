import type { PrismaClient } from '../../generated/prisma/client.js';
import type {
  AdminSession,
  AdminSessionRepository,
  AdminSessionStatus,
  DelegatedSessionScope,
  ListSessionsQuery,
} from './session-types.js';

interface SessionRow {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  amr: string[];
  acr: string;
  revokedAt: Date | null;
  revokeReason: string | null;
  client: { clientId: string } | null;
}

const SELECT = {
  id: true,
  userId: true,
  createdAt: true,
  lastSeenAt: true,
  idleExpiresAt: true,
  absoluteExpiresAt: true,
  ip: true,
  userAgent: true,
  amr: true,
  acr: true,
  revokedAt: true,
  revokeReason: true,
  client: { select: { clientId: true } },
} as const;

const statusOf = (row: SessionRow, now: Date): AdminSessionStatus => {
  if (row.revokedAt !== null) {
    return 'revoked';
  }
  return row.idleExpiresAt <= now || row.absoluteExpiresAt <= now ? 'expired' : 'active';
};

const toSession = (row: SessionRow, now: Date): AdminSession => ({
  id: row.id,
  userId: row.userId,
  clientId: row.client?.clientId ?? null,
  status: statusOf(row, now),
  createdAt: row.createdAt.toISOString(),
  lastSeenAt: row.lastSeenAt.toISOString(),
  idleExpiresAt: row.idleExpiresAt.toISOString(),
  absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
  ip: row.ip ?? null,
  userAgent: row.userAgent,
  amr: row.amr,
  acr: row.acr,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  revokeReason: row.revokeReason,
});

const statusFilter = (status: AdminSessionStatus | undefined, now: Date): object => {
  if (status === 'revoked') {
    return { revokedAt: { not: null } };
  }
  if (status === 'expired') {
    return {
      revokedAt: null,
      OR: [{ idleExpiresAt: { lte: now } }, { absoluteExpiresAt: { lte: now } }],
    };
  }
  if (status === 'active') {
    return { revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } };
  }
  return {};
};

/** Prisma-backed session administration queries. */
export function createPrismaAdminSessionRepository(
  prisma: PrismaClient,
  options: { now?: () => Date } = {},
): AdminSessionRepository {
  const now = options.now ?? (() => new Date());

  return {
    async list(input: ListSessionsQuery, scope?: DelegatedSessionScope) {
      const at = now();
      const where = {
        ...(input.userId === undefined ? {} : { userId: input.userId }),
        ...(input.clientId === undefined ? {} : { client: { clientId: input.clientId } }),
        ...statusFilter(input.status, at),
        ...(scope === undefined
          ? {}
          : {
              clientId: scope.clientUuid,
              // A delegated admin never sees sessions of users that left the app.
              user: {
                memberships: {
                  some: { clientId: scope.clientUuid, loginContextId: null },
                },
              },
            }),
      };

      const [rows, total] = await Promise.all([
        prisma.session.findMany({
          where,
          select: SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (input.page - 1) * input.limit,
          take: input.limit,
        }),
        prisma.session.count({ where }),
      ]);

      return { items: rows.map((row) => toSession(row, at)), total };
    },

    async findById(sid: string) {
      const row = await prisma.session.findUnique({ where: { id: sid }, select: SELECT });
      return row === null ? null : toSession(row, now());
    },

    async revoke(sid: string, revokedAt: Date, reason: string) {
      const result = await prisma.session.updateMany({
        where: { id: sid, revokedAt: null },
        data: { revokedAt, revokeReason: reason },
      });
      return result.count > 0;
    },

    async revokeAllForUser(userId: string, revokedAt: Date, reason: string) {
      const result = await prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt, revokeReason: reason },
      });
      return result.count;
    },

    async revokeAllForUserClient(
      userId: string,
      clientUuid: string,
      revokedAt: Date,
      reason: string,
    ) {
      const result = await prisma.session.updateMany({
        where: { userId, clientId: clientUuid, revokedAt: null },
        data: { revokedAt, revokeReason: reason },
      });
      return result.count;
    },

    async revokeRefreshTokensForUser(userId: string, revokedAt: Date) {
      const result = await prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt },
      });
      return result.count;
    },

    async revokeRefreshTokensForUserClient(userId: string, clientUuid: string, revokedAt: Date) {
      const result = await prisma.refreshToken.updateMany({
        where: { userId, clientId: clientUuid, revokedAt: null },
        data: { revokedAt },
      });
      return result.count;
    },

    async revokeRefreshTokensForSession(sessionId: string, revokedAt: Date) {
      const result = await prisma.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt },
      });
      return result.count;
    },

    async resolveClientUuid(publicClientId: string) {
      const row = await prisma.client.findUnique({
        where: { clientId: publicClientId },
        select: { id: true },
      });
      return row?.id ?? null;
    },

    async isMember(clientUuid: string, userId: string) {
      const row = await prisma.clientMembership.findFirst({
        where: { clientId: clientUuid, userId, loginContextId: null },
        select: { id: true },
      });
      return row !== null;
    },

    async userExists(userId: string) {
      const row = await prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { id: true },
      });
      return row !== null;
    },
  };
}
