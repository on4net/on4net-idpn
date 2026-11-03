import type { PrismaClient } from '../generated/prisma/client.js';
import type { RefreshTokenRecord, RefreshTokenRepository } from './refresh-token.js';

export function createPrismaRefreshTokenRepository(prisma: PrismaClient): RefreshTokenRepository {
  async function internalClientId(clientId: string): Promise<string> {
    const client = await prisma.client.findUniqueOrThrow({
      where: { clientId },
      select: { id: true },
    });
    return client.id;
  }

  return {
    async create(record) {
      await prisma.refreshToken.create({
        data: {
          id: record.id,
          tokenHash: record.tokenHash,
          familyId: record.familyId,
          clientId: await internalClientId(record.clientId),
          userId: record.userId,
          sessionId: record.sessionId,
          scope: record.scope,
          expiresAt: record.expiresAt,
          createdAt: record.createdAt,
          loginContext: record.loginContext ?? null,
        },
      });
    },

    async findByHash(tokenHash) {
      const row = await prisma.refreshToken.findUnique({
        where: { tokenHash },
        include: { client: { select: { clientId: true } } },
      });
      if (row === null) {
        return null;
      }
      const record: RefreshTokenRecord = {
        id: row.id,
        tokenHash: row.tokenHash,
        familyId: row.familyId,
        clientId: row.client.clientId,
        userId: row.userId,
        sessionId: row.sessionId,
        scope: row.scope,
        expiresAt: row.expiresAt,
        rotatedAt: row.rotatedAt,
        revokedAt: row.revokedAt,
        replacedBy: row.replacedBy,
        createdAt: row.createdAt,
        ...(row.loginContext === null ? {} : { loginContext: row.loginContext }),
      };
      return record;
    },

    async markRotated(tokenHash, rotatedAt, replacedById) {
      const result = await prisma.refreshToken.updateMany({
        where: { tokenHash, rotatedAt: null, revokedAt: null },
        data: { rotatedAt, replacedBy: replacedById },
      });
      return result.count === 1;
    },

    async revokeFamily(familyId, revokedAt) {
      const result = await prisma.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt },
      });
      return result.count;
    },

    async revokeByHash(tokenHash, revokedAt) {
      const result = await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt },
      });
      return result.count === 1;
    },
  };
}
