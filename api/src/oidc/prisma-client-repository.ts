import type { PrismaClient } from '../generated/prisma/client.js';
import type { ClientAuthClientRecord, ClientAuthRepository } from './client-auth.js';
import type { ClientRepository, OAuthClient } from './client-repository.js';

const now = (): Date => new Date();

/** Reads OAuth clients (public metadata) and their active secrets from PostgreSQL. */
export function createPrismaClientRepository(
  prisma: PrismaClient,
): ClientRepository & ClientAuthRepository {
  async function load(clientId: string) {
    return prisma.client.findUnique({
      where: { clientId },
      include: {
        secrets: { where: { revokedAt: null } },
        loginContexts: { where: { status: 'active' }, orderBy: { sortOrder: 'asc' } },
      },
    });
  }

  const toOAuthClient = (row: NonNullable<Awaited<ReturnType<typeof load>>>): OAuthClient => {
    const locales = (row.locales ?? {}) as { supported?: string[] };
    return {
      clientId: row.clientId,
      status: row.status,
      type: row.type,
      redirectUris: row.redirectUris,
      scopes: row.scopes,
      requirePkce: row.requirePkce,
      registrationPolicy: row.registrationPolicy,
      mfaPolicy: row.mfaPolicy,
      loginContexts: row.loginContexts.map((context) => context.key),
      locales: locales.supported ?? [],
    };
  };

  return {
    async findByClientId(clientId) {
      const row = await load(clientId);
      return row === null ? null : toOAuthClient(row);
    },

    async findForAuth(clientId): Promise<ClientAuthClientRecord | null> {
      const row = await load(clientId);
      if (row === null) {
        return null;
      }
      const at = now();
      return {
        ...toOAuthClient(row),
        accessTokenTtl: row.accessTokenTtl,
        refreshTokenTtl: row.refreshTokenTtl,
        secretHashes: row.secrets
          .filter((secret) => secret.expiresAt === null || secret.expiresAt > at)
          .map((secret) => secret.secretHash),
      };
    },
  };
}
