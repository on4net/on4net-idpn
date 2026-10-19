import type { PrismaClient } from '../generated/prisma/client.js';
import type { PublicClientSource } from './build.js';

export interface PublicConfigRepository {
  findPublicClient(clientId: string): Promise<PublicClientSource | null>;
}

/**
 * Reads only the fields the public configuration may expose; redirect URIs, scopes and
 * secrets are never selected, so they cannot leak through this endpoint.
 */
export function createPrismaPublicConfigRepository(prisma: PrismaClient): PublicConfigRepository {
  return {
    async findPublicClient(clientId) {
      const row = await prisma.client.findUnique({
        where: { clientId },
        select: {
          clientId: true,
          name: true,
          status: true,
          locales: true,
          branding: true,
          registrationPolicy: true,
          mfaPolicy: true,
          defaultLoginContextKey: true,
          mfeFeatures: true,
          loginContexts: {
            where: { status: 'active' },
            orderBy: { sortOrder: 'asc' },
            select: {
              key: true,
              name: true,
              description: true,
              loginMethods: true,
              mfaPolicy: true,
              registrationPolicy: true,
              branding: true,
            },
          },
          socialProviders: {
            where: { enabled: true },
            select: { provider: true },
          },
        },
      });

      if (row === null || row.status !== 'active') {
        return null;
      }

      return {
        clientId: row.clientId,
        name: row.name,
        status: row.status,
        locales: (row.locales ?? {}) as PublicClientSource['locales'],
        branding: (row.branding ?? {}) as PublicClientSource['branding'],
        registrationPolicy: row.registrationPolicy,
        mfaPolicy: row.mfaPolicy,
        defaultLoginContextKey: row.defaultLoginContextKey,
        mfeFeatures: (row.mfeFeatures ?? {}) as Record<string, unknown>,
        loginContexts: row.loginContexts.map((context) => ({
          key: context.key,
          name: context.name,
          description: context.description,
          methods: context.loginMethods,
          mfaPolicy: context.mfaPolicy,
          registrationPolicy: context.registrationPolicy,
          ...(context.branding === null ? {} : { branding: context.branding }),
        })),
        socialProviders: row.socialProviders.map((provider) => ({
          provider: provider.provider,
          label: provider.provider === 'google' ? 'Google' : 'Facebook',
        })),
      };
    },
  };
}
