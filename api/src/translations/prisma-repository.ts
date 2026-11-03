import type { PrismaClient } from '../generated/prisma/client.js';
import { normalizeLocaleSettings, type LocaleSettings } from './locale-settings.js';

export interface PublicTranslationClient {
  clientId: string;
  status: 'active' | 'disabled';
  settings: LocaleSettings;
}

/** Read-only port for the public bundle; it never selects secrets or unrelated fields. */
export interface PublicTranslationRepository {
  findClient(clientId: string): Promise<PublicTranslationClient | null>;
  findOverrides(clientId: string, locale: string): Promise<Record<string, string>>;
}

export function createPrismaPublicTranslationRepository(
  prisma: PrismaClient,
): PublicTranslationRepository {
  return {
    async findClient(clientId) {
      const row = await prisma.client.findUnique({
        where: { clientId },
        select: { clientId: true, status: true, locales: true, updatedAt: true },
      });
      if (row === null) {
        return null;
      }
      return {
        clientId: row.clientId,
        status: row.status,
        settings: normalizeLocaleSettings(row.locales, {
          fallbackVersion: row.updatedAt.toISOString(),
        }),
      };
    },

    async findOverrides(clientId, locale) {
      const rows = await prisma.clientTranslation.findMany({
        where: { client: { clientId }, locale },
        select: { key: true, value: true },
        orderBy: { key: 'asc' },
      });
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
  };
}
