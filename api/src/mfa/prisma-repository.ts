import type { PrismaClient } from '../generated/prisma/client.js';
import { recordAuditEvent } from '../audit/prisma-audit.js';
import type {
  CreateTotpFactorResult,
  MfaFactorRecord,
  MfaFactorRepository,
  MfaLoginRepository,
  MfaPolicy,
  MfaUserSecurity,
} from './mfa-types.js';

type FactorRow = {
  id: string;
  userId: string;
  type: 'totp' | 'webauthn';
  name: string;
  secretEncrypted: Uint8Array | null;
  credentialId: Uint8Array | null;
  publicKey: Uint8Array | null;
  signCount: bigint;
  transports: string[];
  aaguid: string | null;
  deviceType: string | null;
  backedUp: boolean;
  confirmedAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedStep: bigint | null;
  createdAt: Date;
};

const toRecord = (row: FactorRow): MfaFactorRecord => ({
  id: row.id,
  userId: row.userId,
  type: row.type,
  name: row.name,
  secretEncrypted: row.secretEncrypted === null ? null : Buffer.from(row.secretEncrypted),
  credentialId: row.credentialId === null ? null : Buffer.from(row.credentialId),
  publicKey: row.publicKey === null ? null : Buffer.from(row.publicKey),
  signCount: row.signCount,
  transports: [...row.transports],
  aaguid: row.aaguid,
  deviceType: row.deviceType,
  backedUp: row.backedUp,
  confirmedAt: row.confirmedAt,
  lastUsedAt: row.lastUsedAt,
  lastUsedStep: row.lastUsedStep,
  createdAt: row.createdAt,
});

const FACTOR_SELECT = {
  id: true,
  userId: true,
  type: true,
  name: true,
  secretEncrypted: true,
  credentialId: true,
  publicKey: true,
  signCount: true,
  transports: true,
  aaguid: true,
  deviceType: true,
  backedUp: true,
  confirmedAt: true,
  lastUsedAt: true,
  lastUsedStep: true,
  createdAt: true,
} as const;

export interface MfaPermissionSource {
  globalPermissionsForUser(userId: string): Promise<string[]>;
  clientPermissionsForUser?(userId: string, clientId: string): Promise<string[]>;
}

export interface PrismaMfaRepositoryOptions {
  /** Used only for `required_admins`; without it an admin is a global-role holder. */
  permissions?: MfaPermissionSource;
}

/**
 * Prisma-backed MFA storage (docs/domain-model.md 2.4).
 *
 * All mutations are scoped by `userId` and the security-relevant ones are conditional
 * updates: the TOTP step and a recovery code can be consumed exactly once even when two
 * requests race.
 */
export function createPrismaMfaRepository(
  prisma: PrismaClient,
  options: PrismaMfaRepositoryOptions = {},
): MfaFactorRepository & MfaLoginRepository {
  const findFactor = async (
    userId: string,
    type: 'totp' | 'webauthn',
    confirmedOnly: boolean,
  ): Promise<MfaFactorRecord | null> => {
    const row = await prisma.mfaFactor.findFirst({
      where: {
        userId,
        type,
        ...(confirmedOnly ? { confirmedAt: { not: null } } : {}),
      },
      select: FACTOR_SELECT,
    });
    return row === null ? null : toRecord(row);
  };

  return {
    async listFactors(userId) {
      const rows = await prisma.mfaFactor.findMany({
        where: { userId },
        select: FACTOR_SELECT,
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toRecord);
    },

    async findTotp(userId) {
      return findFactor(userId, 'totp', false);
    },

    async findConfirmedTotp(userId) {
      return findFactor(userId, 'totp', true);
    },

    async findFactor(userId, factorId) {
      const row = await prisma.mfaFactor.findFirst({
        where: { id: factorId, userId },
        select: FACTOR_SELECT,
      });
      return row === null ? null : toRecord(row);
    },

    async listConfirmedWebauthn(userId) {
      const rows = await prisma.mfaFactor.findMany({
        where: { userId, type: 'webauthn', confirmedAt: { not: null } },
        select: FACTOR_SELECT,
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toRecord);
    },

    async findWebauthn(userId, factorId) {
      const row = await prisma.mfaFactor.findFirst({
        where: { id: factorId, userId, type: 'webauthn' },
        select: FACTOR_SELECT,
      });
      return row === null ? null : toRecord(row);
    },

    async findWebauthnByCredentialId(userId, credentialId) {
      const row = await prisma.mfaFactor.findFirst({
        where: {
          userId,
          type: 'webauthn',
          credentialId: new Uint8Array(credentialId),
        },
        select: FACTOR_SELECT,
      });
      return row === null ? null : toRecord(row);
    },

    async createTotpFactor(userId, name, secretEncrypted) {
      try {
        const factor = await prisma.$transaction(async (tx) => {
          const existing = await tx.mfaFactor.findFirst({
            where: { userId, type: 'totp' },
            select: { id: true, confirmedAt: true },
          });
          if (existing !== null && existing.confirmedAt !== null) {
            return null;
          }
          if (existing !== null) {
            // An abandoned enrollment is replaced, so a lost secret never blocks a retry.
            await tx.mfaRecoveryCode.deleteMany({ where: { factorId: existing.id } });
            await tx.mfaFactor.delete({ where: { id: existing.id } });
          }
          return tx.mfaFactor.create({
            data: { userId, type: 'totp', name, secretEncrypted: new Uint8Array(secretEncrypted) },
            select: FACTOR_SELECT,
          });
        });
        if (factor === null) {
          return { ok: false, reason: 'already_enrolled' } satisfies CreateTotpFactorResult;
        }
        return { ok: true, factor: toRecord(factor) } satisfies CreateTotpFactorResult;
      } catch (error) {
        // The partial unique index (`one TOTP per user`) also protects against a race; any
        // other database failure must not be reported as "already enrolled".
        if ((error as { code?: string }).code === 'P2002') {
          return { ok: false, reason: 'already_enrolled' } satisfies CreateTotpFactorResult;
        }
        throw error;
      }
    },

    async confirmFactor(factorId, userId, at) {
      const result = await prisma.mfaFactor.updateMany({
        where: { id: factorId, userId, confirmedAt: null },
        data: { confirmedAt: at },
      });
      return result.count === 1;
    },

    async createWebauthnCredential(userId, credential, at) {
      try {
        const factor = await prisma.mfaFactor.create({
          data: {
            userId,
            type: 'webauthn',
            name: credential.name,
            credentialId: new Uint8Array(credential.credentialId),
            publicKey: new Uint8Array(credential.publicKey),
            signCount: credential.signCount,
            transports: [...credential.transports],
            aaguid: credential.aaguid,
            deviceType: credential.deviceType,
            backedUp: credential.backedUp,
            confirmedAt: at,
          },
          select: FACTOR_SELECT,
        });
        return { ok: true, factor: toRecord(factor) };
      } catch (error) {
        // The global partial unique index on credential_id also covers a concurrent
        // enrollment; any other failure must not be reported as a duplicate.
        if ((error as { code?: string }).code === 'P2002') {
          return { ok: false, reason: 'duplicate_credential' };
        }
        throw error;
      }
    },

    async markTotpUsed(factorId, step, at) {
      const result = await prisma.mfaFactor.updateMany({
        where: {
          id: factorId,
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
        },
        data: { lastUsedStep: step, lastUsedAt: at },
      });
      return result.count === 1;
    },

    async updateWebauthnCounter(factorId, userId, expectedCounter, newCounter, at) {
      // Compare-and-set: a second assertion carrying the same counter loses even when two
      // requests pass the earlier read concurrently.
      const result = await prisma.mfaFactor.updateMany({
        where: {
          id: factorId,
          userId,
          type: 'webauthn',
          signCount: expectedCounter,
        },
        data: { signCount: newCounter, lastUsedAt: at },
      });
      return result.count === 1;
    },

    async renameFactor(factorId, userId, name) {
      const result = await prisma.mfaFactor.updateMany({
        where: { id: factorId, userId, type: 'webauthn' },
        data: { name },
      });
      return result.count === 1;
    },

    async deleteFactor(factorId, userId) {
      const factor = await prisma.mfaFactor.findFirst({
        where: { id: factorId, userId },
        select: { id: true },
      });
      if (factor === null) {
        return false;
      }
      await prisma.$transaction([
        prisma.mfaRecoveryCode.deleteMany({ where: { factorId } }),
        prisma.mfaFactor.delete({ where: { id: factorId } }),
      ]);
      return true;
    },

    async replaceRecoveryCodes(factorId, codeHashes, at) {
      await prisma.$transaction(async (tx) => {
        await tx.mfaRecoveryCode.deleteMany({ where: { factorId } });
        if (codeHashes.length > 0) {
          await tx.mfaRecoveryCode.createMany({
            data: codeHashes.map((codeHash) => ({ factorId, codeHash, createdAt: at })),
          });
        }
      });
    },

    async listUnusedRecoveryCodes(factorId) {
      return prisma.mfaRecoveryCode.findMany({
        where: { factorId, usedAt: null },
        select: { id: true, codeHash: true },
        orderBy: { createdAt: 'asc' },
      });
    },

    async consumeRecoveryCode(codeId, at) {
      const result = await prisma.mfaRecoveryCode.updateMany({
        where: { id: codeId, usedAt: null },
        data: { usedAt: at },
      });
      return result.count === 1;
    },

    async countUnusedRecoveryCodes(factorId) {
      return prisma.mfaRecoveryCode.count({ where: { factorId, usedAt: null } });
    },

    async findUserSecurity(userId): Promise<MfaUserSecurity | null> {
      return prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: {
          id: true,
          tenantId: true,
          username: true,
          email: true,
          status: true,
          passwordHash: true,
          deletedAt: true,
          failedLoginCount: true,
          lockedUntil: true,
        },
      });
    },

    async recordAudit(event) {
      await recordAuditEvent(prisma, event);
    },

    async resolveMfaPolicy({ clientId, loginContext }): Promise<MfaPolicy> {
      if (clientId === undefined || clientId === '') {
        return 'optional';
      }
      const client = await prisma.client.findUnique({
        where: { clientId },
        select: {
          id: true,
          mfaPolicy: true,
          defaultLoginContextKey: true,
          status: true,
        },
      });
      if (client === null || client.status !== 'active') {
        return 'optional';
      }
      const key =
        loginContext !== undefined && loginContext !== ''
          ? loginContext
          : (client.defaultLoginContextKey ?? undefined);
      if (key === undefined) {
        return client.mfaPolicy;
      }
      const context = await prisma.clientLoginContext.findFirst({
        where: { clientId: client.id, key, status: 'active' },
        select: { mfaPolicy: true },
      });
      return context?.mfaPolicy ?? client.mfaPolicy;
    },

    async resolveStepUpRequired({ clientId, loginContext }): Promise<boolean> {
      if (clientId === undefined || clientId === '') {
        return false;
      }
      const client = await prisma.client.findUnique({
        where: { clientId },
        select: { id: true, defaultLoginContextKey: true, status: true },
      });
      if (client === null || client.status !== 'active') {
        return false;
      }
      const key =
        loginContext !== undefined && loginContext !== ''
          ? loginContext
          : (client.defaultLoginContextKey ?? undefined);
      if (key === undefined) {
        return false;
      }
      const context = await prisma.clientLoginContext.findFirst({
        where: { clientId: client.id, key, status: 'active' },
        select: { stepUpRequired: true },
      });
      return context?.stepUpRequired ?? false;
    },

    async isAdmin(userId, clientId) {
      if (options.permissions === undefined) {
        return false;
      }
      const globalPermissions = await options.permissions.globalPermissionsForUser(userId);
      if (globalPermissions.length > 0) {
        return true;
      }
      if (
        clientId === undefined ||
        clientId === '' ||
        options.permissions.clientPermissionsForUser === undefined
      ) {
        return false;
      }
      const clientPermissions = await options.permissions.clientPermissionsForUser(
        userId,
        clientId,
      );
      return clientPermissions.length > 0;
    },
  };
}
