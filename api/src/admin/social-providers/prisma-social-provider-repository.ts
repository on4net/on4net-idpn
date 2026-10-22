import type { PrismaClient } from '../../generated/prisma/client.js';
import type { SocialProvider as PrismaSocialProvider } from '../../generated/prisma/enums.js';
import type {
  AdminSocialProviderRepository,
  SocialProvider,
  SocialProviderRecord,
} from './social-provider-types.js';

/**
 * Columns safe to return to the Admin API. `clientSecretEncrypted` is deliberately absent so
 * a route cannot leak the secret even by spreading the row.
 */
const SELECT = {
  id: true,
  provider: true,
  clientKey: true,
  scopes: true,
  allowedEmailDomains: true,
  enabled: true,
  updatedAt: true,
} as const;

interface SocialProviderRow {
  id: string;
  provider: PrismaSocialProvider;
  clientKey: string;
  scopes: string[];
  allowedEmailDomains: string[];
  enabled: boolean;
  updatedAt: Date;
}

const toRecord = (row: SocialProviderRow): SocialProviderRecord => ({
  id: row.id,
  provider: row.provider,
  clientKey: row.clientKey,
  scopes: row.scopes,
  allowedEmailDomains: row.allowedEmailDomains,
  enabled: row.enabled,
  updatedAt: row.updatedAt.toISOString(),
});

/** Prisma-backed per-app social provider credentials (`docs/domain-model.md` 2.6.1). */
export function createPrismaSocialProviderRepository(
  prisma: PrismaClient,
): AdminSocialProviderRepository {
  const internalClientId = async (clientId: string): Promise<string | null> => {
    const row = await prisma.client.findUnique({
      where: { clientId },
      select: { id: true },
    });
    return row?.id ?? null;
  };

  return {
    async list(clientId) {
      const internalId = await internalClientId(clientId);
      if (internalId === null) {
        return { ok: false, reason: 'client-not-found' };
      }
      const rows = await prisma.clientSocialProvider.findMany({
        where: { clientId: internalId },
        orderBy: { provider: 'asc' },
        select: SELECT,
      });
      return { ok: true, value: rows.map(toRecord) };
    },

    async find(clientId, provider) {
      const internalId = await internalClientId(clientId);
      if (internalId === null) {
        return { ok: false, reason: 'client-not-found' };
      }
      const row = await prisma.clientSocialProvider.findUnique({
        where: { clientId_provider: { clientId: internalId, provider } },
        select: SELECT,
      });
      return { ok: true, value: row === null ? null : toRecord(row) };
    },

    async upsert(clientId, provider, input) {
      const internalId = await internalClientId(clientId);
      if (internalId === null) {
        return { ok: false, reason: 'client-not-found' };
      }
      const existing = await prisma.clientSocialProvider.findUnique({
        where: { clientId_provider: { clientId: internalId, provider } },
        select: { id: true },
      });
      const secret = input.clientSecretEncrypted;
      const requiredSecret = (): Uint8Array<ArrayBuffer> => {
        if (secret === undefined) {
          throw new Error('a client secret is required when creating a social provider');
        }
        return secret;
      };
      if (existing === null) {
        // Fail before writing anything; the column is NOT NULL.
        requiredSecret();
      }
      const data = {
        clientKey: input.clientKey,
        scopes: input.scopes,
        allowedEmailDomains: input.allowedEmailDomains,
        enabled: input.enabled,
        ...(secret === undefined ? {} : { clientSecretEncrypted: secret }),
      };
      const row =
        existing === null
          ? await prisma.clientSocialProvider.create({
              data: {
                clientId: internalId,
                provider,
                ...data,
                clientSecretEncrypted: requiredSecret(),
              },
              select: SELECT,
            })
          : await prisma.clientSocialProvider.update({
              where: { id: existing.id },
              data,
              select: SELECT,
            });
      return { ok: true, value: toRecord(row) };
    },

    async remove(clientId, provider) {
      const internalId = await internalClientId(clientId);
      if (internalId === null) {
        return { ok: false, reason: 'client-not-found' };
      }
      const result = await prisma.clientSocialProvider.deleteMany({
        where: { clientId: internalId, provider },
      });
      return { ok: true, value: result.count > 0 };
    },
  };
}

export type { SocialProvider };
