import type { PrismaClient } from '../../generated/prisma/client.js';
import {
  normalizeLocaleSettings,
  type LocaleSettings,
} from '../../translations/locale-settings.js';
import type {
  AdminTranslationRepository,
  ApplyOverridesInput,
  ApplyOverridesResult,
  DeleteLocaleResult,
  TranslationClient,
  TranslationLocaleSummary,
} from './translation-types.js';

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Prisma-backed translation administration (docs/api.md 3.3.4).
 *
 * `clients.locales` holds the locale settings and the cache version; the new
 * `client_translations` rows hold one value per `(client, locale, key)`. A write bumps the
 * version only when at least one stored value actually changed, so an idempotent PUT does
 * not invalidate caches or produce an empty audit event.
 */
export function createPrismaAdminTranslationRepository(
  prisma: PrismaClient,
): AdminTranslationRepository {
  return {
    async findClient(clientId: string): Promise<TranslationClient | null> {
      const row = await prisma.client.findUnique({
        where: { clientId },
        select: { id: true, clientId: true, locales: true, updatedAt: true },
      });
      if (row === null) {
        return null;
      }
      return {
        id: row.id,
        clientId: row.clientId,
        settings: normalizeLocaleSettings(row.locales, {
          fallbackVersion: row.updatedAt.toISOString(),
        }),
      };
    },

    async updateLocaleSettings(
      clientId: string,
      settings: LocaleSettings,
    ): Promise<LocaleSettings | null> {
      const row = await prisma.client.findUnique({
        where: { clientId },
        select: { id: true, locales: true },
      });
      if (row === null) {
        return null;
      }
      const next = {
        ...asRecord(row.locales),
        default: settings.default,
        supported: settings.supported,
        dir: settings.dir,
        calendar: settings.calendar,
        version: settings.version,
      };
      await prisma.client.update({
        where: { id: row.id },
        data: { locales: next as never },
      });
      return settings;
    },

    async listOverrideLocales(clientId: string): Promise<TranslationLocaleSummary[]> {
      const rows = await prisma.clientTranslation.findMany({
        where: { client: { clientId } },
        select: { locale: true, updatedAt: true },
      });
      const summary = new Map<string, TranslationLocaleSummary>();
      for (const row of rows) {
        const current = summary.get(row.locale);
        if (current === undefined) {
          summary.set(row.locale, {
            locale: row.locale,
            count: 1,
            updatedAt: row.updatedAt.toISOString(),
          });
        } else {
          current.count += 1;
          if (row.updatedAt.toISOString() > current.updatedAt) {
            current.updatedAt = row.updatedAt.toISOString();
          }
        }
      }
      return [...summary.values()].sort((left, right) => left.locale.localeCompare(right.locale));
    },

    async findOverrides(clientId: string, locale: string): Promise<Record<string, string>> {
      const rows = await prisma.clientTranslation.findMany({
        where: { client: { clientId }, locale },
        select: { key: true, value: true },
        orderBy: { key: 'asc' },
      });
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },

    async applyOverrides(
      clientId: string,
      locale: string,
      messages: Record<string, string>,
      input: ApplyOverridesInput,
    ): Promise<ApplyOverridesResult> {
      return prisma.$transaction(async (tx) => {
        const client = await tx.client.findUnique({
          where: { clientId },
          select: { id: true, locales: true, updatedAt: true },
        });
        if (client === null) {
          throw new Error('client does not exist');
        }

        const existing = await tx.clientTranslation.findMany({
          where: { clientId: client.id, locale },
          select: { key: true, value: true },
        });
        const current = new Map(existing.map((row) => [row.key, row.value]));
        const changedKeys = new Set<string>();

        for (const [key, rawValue] of Object.entries(messages)) {
          const deletion = rawValue.trim() === '';
          if (deletion) {
            if (current.has(key)) {
              await tx.clientTranslation.delete({
                where: { clientId_locale_key: { clientId: client.id, locale, key } },
              });
              changedKeys.add(key);
            }
            continue;
          }
          if (current.get(key) === rawValue) {
            continue;
          }
          await tx.clientTranslation.upsert({
            where: { clientId_locale_key: { clientId: client.id, locale, key } },
            create: {
              clientId: client.id,
              locale,
              key,
              value: rawValue,
              updatedBy: input.updatedBy,
              updatedAt: input.at,
            },
            update: {
              value: rawValue,
              updatedBy: input.updatedBy,
              updatedAt: input.at,
            },
          });
          changedKeys.add(key);
        }

        if (changedKeys.size === 0) {
          return {
            changedKeys: [],
            currentVersion: normalizeLocaleSettings(client.locales, {
              fallbackVersion: client.updatedAt.toISOString(),
            }).version,
          };
        }

        await tx.client.update({
          where: { id: client.id },
          data: {
            locales: {
              ...asRecord(client.locales),
              version: input.version,
            } as never,
          },
        });

        return { changedKeys: [...changedKeys].sort(), currentVersion: input.version };
      });
    },

    async deleteLocale(
      clientId: string,
      locale: string,
      input: ApplyOverridesInput,
    ): Promise<DeleteLocaleResult> {
      return prisma.$transaction(async (tx) => {
        const client = await tx.client.findUnique({
          where: { clientId },
          select: { id: true, locales: true, updatedAt: true },
        });
        if (client === null) {
          throw new Error('client does not exist');
        }
        const rows = await tx.clientTranslation.findMany({
          where: { clientId: client.id, locale },
          select: { key: true },
          orderBy: { key: 'asc' },
        });
        if (rows.length === 0) {
          return {
            deletedKeys: [],
            currentVersion: normalizeLocaleSettings(client.locales, {
              fallbackVersion: client.updatedAt.toISOString(),
            }).version,
          };
        }
        await tx.clientTranslation.deleteMany({
          where: { clientId: client.id, locale },
        });
        await tx.client.update({
          where: { id: client.id },
          data: {
            locales: {
              ...asRecord(client.locales),
              version: input.version,
            } as never,
          },
        });
        return {
          deletedKeys: rows.map((row) => row.key),
          currentVersion: input.version,
        };
      });
    },
  };
}
