import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { matchLocale } from '@idpn/i18n/locale';

import type { AdminAudit } from '../admin-types.js';
import {
  authorizeAdminRequest,
  type AdminAuthorization,
  type PermissionReader,
  type TokenVerifier,
} from '../authorize.js';
import { sendProblem } from '../routes.js';
import { bundleCacheKey } from '../../translations/cache.js';
import {
  CALENDARS,
  localeSettingsFromInput,
  MAX_LOCALE_LENGTH,
} from '../../translations/locale-settings.js';
import type { AdminTranslationRepository, BundleCacheInvalidator } from './translation-types.js';
import { localeSettingsProblems, validateMessages } from './translation-validation.js';

export interface TranslationAdminRoutesOptions {
  issuer: string;
  adminClientId: string;
  verifier: TokenVerifier;
  permissions: PermissionReader;
  translations: AdminTranslationRepository;
  audit: AdminAudit;
  cache?: BundleCacheInvalidator;
  now?: () => Date;
}

const localeSchema = z.string().trim().min(1).max(MAX_LOCALE_LENGTH);

const localesSchema = z
  .object({
    default: localeSchema.optional(),
    supported: z.array(localeSchema).max(20).optional(),
    calendar: z.enum(CALENDARS).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.default !== undefined || value.supported !== undefined || value.calendar !== undefined,
    { message: 'at least one field is required' },
  );

const messagesSchema = z.object({ messages: z.unknown() }).strict();

const problemsDetail = (problems: string[]): string => problems.join('; ');

/**
 * Per-client locale and translation administration (docs/api.md 3.3.4,
 * docs/localization.md 7). Every route passes the path `clientId` to the existing admin
 * guard, so a delegated token can only act on its own app.
 */
export function registerTranslationAdminRoutes(
  app: FastifyInstance,
  options: TranslationAdminRoutesOptions,
): void {
  const now = options.now ?? (() => new Date());

  const guard = async (
    request: FastifyRequest,
    reply: FastifyReply,
    permission: string,
    clientId: string,
  ): Promise<{ userId: string; clientId: string } | null> => {
    const auth: AdminAuthorization = await authorizeAdminRequest(
      request,
      {
        issuer: options.issuer,
        adminClientId: options.adminClientId,
        verifier: options.verifier,
        permissions: options.permissions,
      },
      { permission, clientId },
    );
    if (!auth.ok) {
      if (auth.status === 401) {
        reply.header('WWW-Authenticate', '******"invalid_token"');
      }
      void sendProblem(
        reply,
        auth.status,
        auth.status === 401 ? 'unauthorized' : 'forbidden',
        auth.status === 401 ? 'Unauthorized' : 'Forbidden',
        auth.message,
      );
      return null;
    }
    return { userId: auth.principal.userId, clientId: auth.principal.clientId };
  };

  const audit = async (
    request: FastifyRequest,
    principal: { userId: string; clientId: string },
    action: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    await options.audit.record({
      actorType: 'admin',
      actorId: principal.userId,
      action,
      targetType: 'client',
      targetId,
      clientId: principal.clientId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'success',
      metadata,
    });
  };

  const invalidate = async (clientId: string, locales: readonly string[]): Promise<void> => {
    if (options.cache === undefined) {
      return;
    }
    const unique = [...new Set(locales.map((locale) => locale.toLowerCase()))];
    await Promise.all(
      unique.map(async (locale) => {
        try {
          await options.cache?.delete(bundleCacheKey(clientId, locale));
        } catch {
          // Cache invalidation is best effort; the short TTL bounds staleness.
        }
      }),
    );
  };

  const resolveSupportedLocale = (value: string, supported: readonly string[]): string | null => {
    const matched = matchLocale(value, supported);
    return matched ?? null;
  };

  app.get<{ Params: { clientId: string } }>(
    '/api/v1/clients/:clientId/locales',
    async (request, reply) => {
      const principal = await guard(
        request,
        reply,
        'idp:client-locale:read',
        request.params.clientId,
      );
      if (principal === null) {
        return reply;
      }
      const client = await options.translations.findClient(request.params.clientId);
      if (client === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
      }
      return reply.send(client.settings);
    },
  );

  app.put<{ Params: { clientId: string } }>(
    '/api/v1/clients/:clientId/locales',
    async (request, reply) => {
      const principal = await guard(
        request,
        reply,
        'idp:client-locale:write',
        request.params.clientId,
      );
      if (principal === null) {
        return reply;
      }
      const client = await options.translations.findClient(request.params.clientId);
      if (client === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
      }

      const parsed = localesSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          problemsDetail(
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          ),
        );
      }

      const next = {
        default: parsed.data.default ?? client.settings.default,
        supported: parsed.data.supported ?? client.settings.supported,
        calendar: parsed.data.calendar ?? client.settings.calendar,
      };
      const problems = localeSettingsProblems(next);
      if (problems.length > 0) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          problemsDetail(problems),
        );
      }

      const version = now().toISOString();
      const settings = localeSettingsFromInput(next, version);
      const updated = await options.translations.updateLocaleSettings(client.clientId, settings);
      if (updated === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
      }

      await invalidate(client.clientId, [
        client.settings.default,
        ...client.settings.supported,
        updated.default,
        ...updated.supported,
      ]);
      await audit(request, principal, 'client.locale.updated', client.id, {
        clientId: client.clientId,
        default: updated.default,
        supported: updated.supported,
        calendar: updated.calendar,
      });
      return reply.send(updated);
    },
  );

  app.get<{ Params: { clientId: string } }>(
    '/api/v1/clients/:clientId/translations',
    async (request, reply) => {
      const principal = await guard(
        request,
        reply,
        'idp:client-locale:read',
        request.params.clientId,
      );
      if (principal === null) {
        return reply;
      }
      const client = await options.translations.findClient(request.params.clientId);
      if (client === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
      }
      const locales = await options.translations.listOverrideLocales(client.clientId);
      return reply.send({ locales: locales.map((entry) => entry.locale) });
    },
  );

  app.get<{ Params: { clientId: string; locale: string } }>(
    '/api/v1/clients/:clientId/translations/:locale',
    async (request, reply) => {
      const principal = await guard(
        request,
        reply,
        'idp:client-locale:read',
        request.params.clientId,
      );
      if (principal === null) {
        return reply;
      }
      const client = await options.translations.findClient(request.params.clientId);
      if (client === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
      }
      const locale = resolveSupportedLocale(request.params.locale, client.settings.supported);
      if (locale === null) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          'locale: must be one of the supported locales',
        );
      }
      const messages = await options.translations.findOverrides(client.clientId, locale);
      return reply.send({ locale, messages, version: client.settings.version });
    },
  );

  app.put<{ Params: { clientId: string; locale: string } }>(
    '/api/v1/clients/:clientId/translations/:locale',
    async (request, reply) => {
      const principal = await guard(
        request,
        reply,
        'idp:client-locale:write',
        request.params.clientId,
      );
      if (principal === null) {
        return reply;
      }
      const client = await options.translations.findClient(request.params.clientId);
      if (client === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
      }
      const locale = resolveSupportedLocale(request.params.locale, client.settings.supported);
      if (locale === null) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          'locale: must be one of the supported locales',
        );
      }

      const parsed = messagesSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          problemsDetail(
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          ),
        );
      }
      const validation = validateMessages(parsed.data.messages);
      if (validation.problems.length > 0) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          problemsDetail(validation.problems),
        );
      }

      const changes: Record<string, string> = { ...validation.messages };
      for (const key of validation.deletions) {
        changes[key] = '';
      }

      const at = now();
      const result = await options.translations.applyOverrides(client.clientId, locale, changes, {
        updatedBy: principal.userId,
        version: at.toISOString(),
        at,
      });
      if (result.changedKeys.length > 0) {
        await invalidate(client.clientId, [locale]);
        await audit(request, principal, 'client.translation.updated', client.id, {
          clientId: client.clientId,
          locale,
          keys: result.changedKeys,
        });
      }

      const messages = await options.translations.findOverrides(client.clientId, locale);
      return reply.send({ locale, messages, version: result.currentVersion });
    },
  );

  app.delete<{ Params: { clientId: string; locale: string } }>(
    '/api/v1/clients/:clientId/translations/:locale',
    async (request, reply) => {
      const principal = await guard(
        request,
        reply,
        'idp:client-locale:write',
        request.params.clientId,
      );
      if (principal === null) {
        return reply;
      }
      const client = await options.translations.findClient(request.params.clientId);
      if (client === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
      }
      const locale = resolveSupportedLocale(request.params.locale, client.settings.supported);
      if (locale === null) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          'locale: must be one of the supported locales',
        );
      }

      const at = now();
      const result = await options.translations.deleteLocale(client.clientId, locale, {
        updatedBy: principal.userId,
        version: at.toISOString(),
        at,
      });
      if (result.deletedKeys.length > 0) {
        await invalidate(client.clientId, [locale]);
        await audit(request, principal, 'client.translation.updated', client.id, {
          clientId: client.clientId,
          locale,
          keys: result.deletedKeys,
        });
      }
      return reply.code(204).send();
    },
  );
}
