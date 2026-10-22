import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { SecretBox } from '../../crypto/secret-box.js';
import type { AdminAudit, AdminPrincipal } from '../admin-types.js';
import {
  authorizeAdminRequest,
  type AdminAuthorization,
  type AdminRequirement,
  type PermissionReader,
  type TokenVerifier,
} from '../authorize.js';
import { sendProblem } from '../routes.js';
import {
  DEFAULT_SOCIAL_SCOPES,
  SOCIAL_PROVIDERS,
  socialCallbackUrl,
  type AdminSocialProvider,
  type AdminSocialProviderRepository,
  type SocialProvider,
  type SocialProviderRecord,
} from './social-provider-types.js';

export interface SocialProviderRoutesOptions {
  issuer: string;
  adminClientId: string;
  verifier: TokenVerifier;
  permissions: PermissionReader;
  providers: AdminSocialProviderRepository;
  audit: AdminAudit;
  /**
   * Encrypts client secrets with AES-256-GCM. `null` only outside production, where no
   * `SOCIAL_SECRET_KEY` is configured; writes then fail closed with `503`.
   */
  secretBox: SecretBox | null;
}

const SOCIAL_READ = 'idp:social-provider:read';
const SOCIAL_WRITE = 'idp:social-provider:write';

const providerSchema = z.enum(SOCIAL_PROVIDERS);

const domainSchema = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
    'must be a domain name such as example.com',
  )
  .transform((value) => value.toLowerCase());

const scopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, 'must be a scope token');

const upsertSchema = z.object({
  clientKey: z.string().trim().min(1).max(512),
  /** Write-only. On update it may be omitted to keep the stored credential. */
  clientSecret: z.string().min(1).max(2048).optional(),
  scopes: z.array(scopeSchema).min(1).max(40).optional(),
  allowedEmailDomains: z.array(domainSchema).max(50).optional(),
  enabled: z.boolean().optional(),
});

const validationDetail = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

/**
 * Per-app Google/Facebook credentials (`docs/api.md` 3.3.2).
 *
 * A delegated app admin may only use the `clientId` of its own token: the guard rejects
 * another app with `403` before any row is read. The secret is write-only; no handler or
 * repository projection contains it, and audit metadata carries only the provider name.
 */
export function registerSocialProviderAdminRoutes(
  app: FastifyInstance,
  options: SocialProviderRoutesOptions,
): void {
  const guard = async (
    request: FastifyRequest,
    reply: FastifyReply,
    requirement: AdminRequirement,
  ): Promise<AdminPrincipal | null> => {
    const auth: AdminAuthorization = await authorizeAdminRequest(
      request,
      {
        issuer: options.issuer,
        adminClientId: options.adminClientId,
        verifier: options.verifier,
        permissions: options.permissions,
      },
      requirement,
    );
    if (!auth.ok) {
      if (auth.status === 401) {
        reply.header('WWW-Authenticate', 'Bearer error="invalid_token"');
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
    return auth.principal;
  };

  const validationFailure = (reply: FastifyReply, detail: string) =>
    sendProblem(reply, 422, 'validation-error', 'Validation failed', detail);

  const clientNotFound = (reply: FastifyReply) =>
    sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');

  const toResponse = (record: SocialProviderRecord, clientId: string): AdminSocialProvider => ({
    provider: record.provider,
    clientKey: record.clientKey,
    scopes: record.scopes,
    allowedEmailDomains: record.allowedEmailDomains,
    enabled: record.enabled,
    callbackUrl: socialCallbackUrl(options.issuer, clientId, record.provider),
    updatedAt: record.updatedAt,
  });

  const audit = async (
    request: FastifyRequest,
    principal: AdminPrincipal,
    action: 'social-provider.update' | 'social-provider.delete',
    clientId: string,
    targetId: string,
    provider: SocialProvider,
  ): Promise<void> => {
    await options.audit.record({
      actorType: 'admin',
      actorId: principal.userId,
      action,
      targetType: 'social_provider',
      targetId,
      clientId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'success',
      // Provider name only: the clientKey is public but unnecessary, and the secret must
      // never reach the audit log (docs/security.md 7).
      metadata: { provider },
    });
  };

  app.get<{ Params: { clientId: string } }>(
    '/api/v1/clients/:clientId/social-providers',
    async (request, reply) => {
      const clientId = request.params.clientId;
      if ((await guard(request, reply, { permission: SOCIAL_READ, clientId })) === null) {
        return reply;
      }
      const result = await options.providers.list(clientId);
      if (!result.ok) {
        return clientNotFound(reply);
      }
      return reply
        .header('Cache-Control', 'no-store')
        .send({ items: result.value.map((record) => toResponse(record, clientId)) });
    },
  );

  app.put<{ Params: { clientId: string; provider: string } }>(
    '/api/v1/clients/:clientId/social-providers/:provider',
    async (request, reply) => {
      const clientId = request.params.clientId;
      const principal = await guard(request, reply, {
        permission: SOCIAL_WRITE,
        clientId,
        stepUp: true,
      });
      if (principal === null) {
        return reply;
      }
      const provider = providerSchema.safeParse(request.params.provider);
      if (!provider.success) {
        return validationFailure(reply, `provider: must be one of ${SOCIAL_PROVIDERS.join(', ')}`);
      }
      const parsed = upsertSchema.safeParse(request.body);
      if (!parsed.success) {
        return validationFailure(reply, validationDetail(parsed.error));
      }
      const body = parsed.data;

      const existing = await options.providers.find(clientId, provider.data);
      if (!existing.ok) {
        return clientNotFound(reply);
      }
      if (existing.value === null && body.clientSecret === undefined) {
        return validationFailure(reply, 'clientSecret: is required when creating a provider');
      }
      let secret: Uint8Array<ArrayBuffer> | undefined;
      if (body.clientSecret !== undefined) {
        if (options.secretBox === null) {
          return sendProblem(
            reply,
            503,
            'service-unavailable',
            'Service unavailable',
            'social provider secret encryption is not configured',
          );
        }
        secret = new Uint8Array(options.secretBox.encrypt(body.clientSecret));
      }

      const scopes = body.scopes ?? existing.value?.scopes ?? [...DEFAULT_SOCIAL_SCOPES];
      const allowedEmailDomains =
        body.allowedEmailDomains ?? existing.value?.allowedEmailDomains ?? [];
      const enabled = body.enabled ?? existing.value?.enabled ?? true;

      const saved = await options.providers.upsert(clientId, provider.data, {
        clientKey: body.clientKey,
        scopes,
        allowedEmailDomains,
        enabled,
        ...(secret === undefined ? {} : { clientSecretEncrypted: secret }),
      });
      if (!saved.ok) {
        return clientNotFound(reply);
      }
      await audit(
        request,
        principal,
        'social-provider.update',
        clientId,
        saved.value.id,
        provider.data,
      );
      return reply.header('Cache-Control', 'no-store').send(toResponse(saved.value, clientId));
    },
  );

  app.delete<{ Params: { clientId: string; provider: string } }>(
    '/api/v1/clients/:clientId/social-providers/:provider',
    async (request, reply) => {
      const clientId = request.params.clientId;
      const principal = await guard(request, reply, {
        permission: SOCIAL_WRITE,
        clientId,
        stepUp: true,
      });
      if (principal === null) {
        return reply;
      }
      const provider = providerSchema.safeParse(request.params.provider);
      if (!provider.success) {
        return validationFailure(reply, `provider: must be one of ${SOCIAL_PROVIDERS.join(', ')}`);
      }

      const existing = await options.providers.find(clientId, provider.data);
      if (!existing.ok) {
        return clientNotFound(reply);
      }
      if (existing.value === null) {
        return sendProblem(
          reply,
          404,
          'not-found',
          'Not found',
          'social provider is not configured for this client',
        );
      }
      const removed = await options.providers.remove(clientId, provider.data);
      if (!removed.ok) {
        return clientNotFound(reply);
      }
      if (!removed.value) {
        return sendProblem(
          reply,
          404,
          'not-found',
          'Not found',
          'social provider is not configured for this client',
        );
      }
      await audit(
        request,
        principal,
        'social-provider.delete',
        clientId,
        existing.value.id,
        provider.data,
      );
      return reply.code(204).send();
    },
  );
}
