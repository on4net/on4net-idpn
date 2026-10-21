import type { PrismaClient } from '../generated/prisma/client.js';
import type { ClientAuthClientRecord, ClientAuthRepository } from './client-auth.js';
import type { ClientRepository, OAuthClient } from './client-repository.js';

const now = (): Date => new Date();

/** Reads OAuth clients (public metadata) and their active secrets from PostgreSQL. */
export function createPrismaClientRepository(
  prisma: PrismaClient,
): ClientRepository &
  ClientAuthRepository & { findAllowedOrigins(clientId: string): Promise<string[]> } {
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
    const contextKeys = row.loginContexts.map((context) => context.key);
    return {
      clientId: row.clientId,
      status: row.status,
      type: row.type,
      redirectUris: row.redirectUris,
      postLogoutRedirectUris: row.postLogoutRedirectUris,
      backchannelLogoutUri: row.backchannelLogoutUri,
      scopes: row.scopes,
      requirePkce: row.requirePkce,
      registrationPolicy: row.registrationPolicy,
      mfaPolicy: row.mfaPolicy,
      loginContexts: contextKeys,
      // The default only counts when it is an active context of this client.
      ...(row.defaultLoginContextKey !== null && contextKeys.includes(row.defaultLoginContextKey)
        ? { defaultLoginContext: row.defaultLoginContextKey }
        : {}),
      locales: locales.supported ?? [],
    };
  };

  return {
    async findByClientId(clientId) {
      const row = await load(clientId);
      return row === null ? null : toOAuthClient(row);
    },

    async findAllowedOrigins(clientId) {
      const row = await prisma.client.findUnique({
        where: { clientId },
        select: { allowedOrigins: true },
      });
      return row?.allowedOrigins ?? [];
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

    /**
     * Rewrites a legacy (Argon2id) or rotated-pepper hash in place after a successful
     * verification. Scoped to the client and to the exact stored hash, so a concurrent
     * rotation can never overwrite a different row.
     */
    async rehashSecret(clientId, previousHash, nextHash): Promise<void> {
      const client = await prisma.client.findUnique({
        where: { clientId },
        select: { id: true },
      });
      if (client === null) {
        return;
      }
      await prisma.clientSecret.updateMany({
        where: { clientId: client.id, secretHash: previousHash, revokedAt: null },
        data: { secretHash: nextHash },
      });
    },
  };
}
