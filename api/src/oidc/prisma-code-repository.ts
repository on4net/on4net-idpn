import type { PrismaClient } from '../generated/prisma/client.js';
import type { AuthorizationCodeRecord, AuthorizationCodeRepository } from './authorization-code.js';

/** Prisma-backed authorization code store (codes are looked up by their SHA-256 hash). */
export function createPrismaCodeRepository(prisma: PrismaClient): AuthorizationCodeRepository {
  async function internalClientId(clientId: string): Promise<string> {
    const client = await prisma.client.findUniqueOrThrow({
      where: { clientId },
      select: { id: true },
    });
    return client.id;
  }

  return {
    async create(record) {
      await prisma.authorizationCode.create({
        data: {
          codeHash: record.codeHash,
          clientId: await internalClientId(record.clientId),
          userId: record.userId,
          sessionId: record.sessionId,
          redirectUri: record.redirectUri,
          scope: record.scope,
          nonce: record.nonce,
          codeChallenge: record.codeChallenge,
          codeChallengeMethod: record.codeChallengeMethod,
          authTime: record.authTime,
          acr: record.acr,
          amr: record.amr,
          expiresAt: record.expiresAt,
        },
      });
    },

    async findByHash(codeHash) {
      const row = await prisma.authorizationCode.findUnique({
        where: { codeHash },
        include: { client: { select: { clientId: true } } },
      });
      if (row === null) {
        return null;
      }
      const record: AuthorizationCodeRecord = {
        codeHash: row.codeHash,
        clientId: row.client.clientId,
        userId: row.userId,
        sessionId: row.sessionId,
        redirectUri: row.redirectUri,
        scope: row.scope,
        nonce: row.nonce,
        codeChallenge: row.codeChallenge,
        codeChallengeMethod: 'S256',
        authTime: row.authTime,
        acr: row.acr,
        amr: row.amr,
        expiresAt: row.expiresAt,
        consumedAt: row.consumedAt,
      };
      return record;
    },

    /**
     * Atomically marks the code as consumed. `updateMany` with `consumedAt: null` makes a
     * concurrent double exchange impossible: only one call sees `count === 1`.
     */
    async markConsumed(codeHash, consumedAt) {
      const result = await prisma.authorizationCode.updateMany({
        where: { codeHash, consumedAt: null },
        data: { consumedAt },
      });
      return result.count === 1;
    },
  };
}
