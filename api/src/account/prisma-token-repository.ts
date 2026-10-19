import type { PrismaClient } from '../generated/prisma/client.js';
import type { AccountTokenPurpose, AccountTokenStore, TokenConsumption } from './tokens.js';

/** Prisma-backed single-use token store for invite, verification and reset flows. */
export function createPrismaAccountTokenStore(prisma: PrismaClient): AccountTokenStore {
  return {
    async create(input) {
      await prisma.accountToken.create({
        data: {
          userId: input.userId,
          purpose: input.purpose,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          createdAt: input.createdAt,
        },
      });
    },

    async invalidateActive(userId, purpose, at) {
      const result = await prisma.accountToken.updateMany({
        where: { userId, purpose, consumedAt: null },
        data: { consumedAt: at },
      });
      return result.count;
    },

    async findByHash(tokenHash) {
      const row = await prisma.accountToken.findUnique({
        where: { tokenHash },
        select: { userId: true, purpose: true, expiresAt: true, consumedAt: true },
      });
      if (row === null) {
        return null;
      }
      return {
        userId: row.userId,
        purpose: row.purpose as AccountTokenPurpose,
        expiresAt: row.expiresAt,
        consumedAt: row.consumedAt,
      };
    },

    async consume(tokenHash, purpose, at, expectedUserId): Promise<TokenConsumption> {
      const consumed = await prisma.accountToken.updateMany({
        where: {
          tokenHash,
          purpose,
          consumedAt: null,
          expiresAt: { gt: at },
          ...(expectedUserId === undefined ? {} : { userId: expectedUserId }),
        },
        data: { consumedAt: at },
      });
      if (consumed.count === 1) {
        const row = await prisma.accountToken.findUnique({
          where: { tokenHash },
          select: { userId: true },
        });
        return row === null ? { ok: false, reason: 'invalid' } : { ok: true, userId: row.userId };
      }

      // Only reached on failure: report why without ever exposing token material.
      const row = await prisma.accountToken.findUnique({
        where: { tokenHash },
        select: { userId: true, purpose: true, expiresAt: true, consumedAt: true },
      });
      if (row === null || row.purpose !== purpose) {
        return { ok: false, reason: 'invalid' };
      }
      if (expectedUserId !== undefined && row.userId !== expectedUserId) {
        return { ok: false, reason: 'wrong_user' };
      }
      if (row.consumedAt !== null) {
        return { ok: false, reason: 'used' };
      }
      return { ok: false, reason: 'expired' };
    },
  };
}
