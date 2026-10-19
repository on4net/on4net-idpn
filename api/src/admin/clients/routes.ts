import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { hashPassword } from '../../auth/password.js';
import { sendProblem } from '../routes.js';
import {
  authorizeAdminRequest,
  type AdminAuthorization,
  type PermissionReader,
  type TokenVerifier,
} from '../authorize.js';
import type { AdminAudit } from '../admin-types.js';
import {
  CLIENT_TYPES,
  MFA_POLICIES,
  REGISTRATION_POLICIES,
  clientInputProblems,
  uriListProblems,
  uriProblem,
  type ClientInput,
  type ClientType,
} from './client-validation.js';
import type {
  AdminClientDetail,
  AdminClientRepository,
  ClientSecretSummary,
  CreateClientInput,
} from './client-types.js';

export interface ClientRoutesOptions {
  issuer: string;
  adminClientId: string;
  verifier: TokenVerifier;
  permissions: PermissionReader;
  clients: AdminClientRepository;
  audit: AdminAudit;
  hashPassword?: (plain: string) => Promise<string>;
  generateSecret?: () => string;
  now?: () => Date;
}

const uriList = z.array(z.string().min(1)).max(20);
const scopeList = z.array(z.string().min(1)).max(40);

const createSchema = z.object({
  clientId: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'letters, digits, dot, dash and underscore only'),
  name: z.string().trim().min(1).max(120),
  type: z.enum(CLIENT_TYPES),
  redirectUris: uriList.default([]),
  postLogoutRedirectUris: uriList.default([]),
  allowedOrigins: uriList.default([]),
  scopes: scopeList.default([]),
  accessTokenTtl: z.number().int().default(600),
  refreshTokenTtl: z.number().int().default(2_592_000),
  requirePkce: z.boolean().default(true),
  registrationPolicy: z.enum(REGISTRATION_POLICIES).default('invite_only'),
  mfaPolicy: z.enum(MFA_POLICIES).default('optional'),
  backchannelLogoutUri: z.string().min(1).nullable().default(null),
  frontchannelLogoutUri: z.string().min(1).nullable().default(null),
  allowedEmailDomains: z.array(z.string().min(1)).max(50).default([]),
  locales: z.record(z.string(), z.unknown()).default({}),
  branding: z.record(z.string(), z.unknown()).default({}),
  mfeFeatures: z.record(z.string(), z.unknown()).default({}),
  membershipSchema: z.record(z.string(), z.unknown()).nullable().default(null),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    redirectUris: uriList.optional(),
    postLogoutRedirectUris: uriList.optional(),
    allowedOrigins: uriList.optional(),
    scopes: scopeList.optional(),
    accessTokenTtl: z.number().int().optional(),
    refreshTokenTtl: z.number().int().optional(),
    requirePkce: z.boolean().optional(),
    registrationPolicy: z.enum(REGISTRATION_POLICIES).optional(),
    mfaPolicy: z.enum(MFA_POLICIES).optional(),
    backchannelLogoutUri: z.string().min(1).nullable().optional(),
    frontchannelLogoutUri: z.string().min(1).nullable().optional(),
    allowedEmailDomains: z.array(z.string().min(1)).max(50).optional(),
    locales: z.record(z.string(), z.unknown()).optional(),
    branding: z.record(z.string(), z.unknown()).optional(),
    mfeFeatures: z.record(z.string(), z.unknown()).optional(),
    membershipSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

const listSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const issueSecretSchema = z.object({
  expiresAt: z.string().datetime().optional(),
});

const problemsDetail = (problems: string[]): string => problems.join('; ');

const defaultGenerateSecret = (): string => randomBytes(32).toString('base64url');

/** Registers the client administration endpoints (docs/api.md 3.3). */
export function registerClientAdminRoutes(
  app: FastifyInstance,
  options: ClientRoutesOptions,
): void {
  const now = options.now ?? (() => new Date());
  const hash = options.hashPassword ?? ((plain: string) => hashPassword(plain));
  const generateSecret = options.generateSecret ?? defaultGenerateSecret;

  const guard = async (
    request: FastifyRequest,
    reply: FastifyReply,
    permission: string,
  ): Promise<{ userId: string; clientId: string } | null> => {
    const auth: AdminAuthorization = await authorizeAdminRequest(
      request,
      {
        issuer: options.issuer,
        adminClientId: options.adminClientId,
        verifier: options.verifier,
        permissions: options.permissions,
      },
      permission,
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
    return { userId: auth.principal.userId, clientId: auth.principal.clientId };
  };

  const audit = async (
    request: FastifyRequest,
    principal: { userId: string; clientId: string },
    action: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
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

  app.get('/api/v1/clients', async (request, reply) => {
    const principal = await guard(request, reply, 'idp:client:read');
    if (principal === null) {
      return reply;
    }
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        problemsDetail(
          parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        ),
        '/api/v1/clients',
      );
    }
    const { page, limit, q, status } = parsed.data;
    const result = await options.clients.list({
      page,
      limit,
      ...(q === undefined ? {} : { query: q }),
      ...(status === undefined ? {} : { status }),
    });
    return reply.send({ items: result.items, page, limit, total: result.total });
  });

  app.post('/api/v1/clients', async (request, reply) => {
    const principal = await guard(request, reply, 'idp:client:write');
    if (principal === null) {
      return reply;
    }
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        problemsDetail(
          parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        ),
        '/api/v1/clients',
      );
    }

    const body = parsed.data;
    const problems = clientInputProblems(body as ClientInput & { type: ClientType }, {
      adminClientId: options.adminClientId,
    });
    if (body.type === 'web') {
      problems.push(...uriListProblems(body.allowedOrigins, 'allowedOrigins'));
    }
    if (problems.length > 0) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        problemsDetail(problems),
        '/api/v1/clients',
      );
    }
    if ((await options.clients.findByClientId(body.clientId)) !== null) {
      return sendProblem(
        reply,
        409,
        'conflict',
        'Conflict',
        'a client with this clientId already exists',
        '/api/v1/clients',
      );
    }

    const created = await options.clients.create(body as CreateClientInput);
    let clientSecret: string | undefined;
    if (body.type !== 'spa' && body.type !== 'mobile') {
      clientSecret = generateSecret();
      await options.clients.addSecret(created.clientId, {
        secretHash: await hash(clientSecret),
        prefix: clientSecret.slice(0, 12),
        expiresAt: null,
      });
    }

    const detail = await options.clients.findByClientId(created.clientId);
    const finalDetail = detail ?? created;
    await audit(request, principal, 'client.create', finalDetail.id, {
      clientId: created.clientId,
      type: created.type,
      scopes: created.scopes,
    });
    const response: { client: AdminClientDetail; clientSecret?: string } = {
      client: finalDetail,
    };
    if (clientSecret !== undefined) {
      response.clientSecret = clientSecret;
    }
    return reply.code(201).send(response);
  });

  app.get<{ Params: { clientId: string } }>('/api/v1/clients/:clientId', async (request, reply) => {
    const principal = await guard(request, reply, 'idp:client:read');
    if (principal === null) {
      return reply;
    }
    const client = await options.clients.findByClientId(request.params.clientId);
    if (client === null) {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
    }
    return reply.send(client);
  });

  app.patch<{ Params: { clientId: string } }>(
    '/api/v1/clients/:clientId',
    async (request, reply) => {
      const principal = await guard(request, reply, 'idp:client:write');
      if (principal === null) {
        return reply;
      }
      const parsed = updateSchema.safeParse(request.body);
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
      const existing = await options.clients.findByClientId(request.params.clientId);
      if (existing === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
      }

      const patch = parsed.data;
      const merged = {
        clientId: existing.clientId,
        type: existing.type,
        redirectUris: patch.redirectUris ?? existing.redirectUris,
        postLogoutRedirectUris: patch.postLogoutRedirectUris ?? existing.postLogoutRedirectUris,
        scopes: patch.scopes ?? existing.scopes,
        accessTokenTtl: patch.accessTokenTtl ?? existing.accessTokenTtl,
        refreshTokenTtl: patch.refreshTokenTtl ?? existing.refreshTokenTtl,
        backchannelLogoutUri:
          patch.backchannelLogoutUri === undefined
            ? existing.backchannelLogoutUri
            : patch.backchannelLogoutUri,
        frontchannelLogoutUri:
          patch.frontchannelLogoutUri === undefined
            ? existing.frontchannelLogoutUri
            : patch.frontchannelLogoutUri,
        branding: patch.branding ?? existing.branding,
        mfeFeatures: patch.mfeFeatures ?? existing.mfeFeatures,
        membershipSchema:
          patch.membershipSchema === undefined ? existing.membershipSchema : patch.membershipSchema,
      };

      const problems = clientInputProblems(merged, { adminClientId: options.adminClientId });
      if (patch.allowedOrigins !== undefined) {
        problems.push(...uriListProblems(patch.allowedOrigins, 'allowedOrigins'));
      }
      for (const [field, value] of Object.entries(patch)) {
        if ((field.endsWith('Uri') || field === 'logoUrl') && typeof value === 'string') {
          const problem = uriProblem(value);
          if (problem !== null && !problems.some((entry) => entry.startsWith(`${field}:`))) {
            problems.push(`${field}: ${problem}`);
          }
        }
      }
      if (problems.length > 0) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          problemsDetail(problems),
        );
      }

      const updated = await options.clients.update(existing.clientId, patch);
      if (updated === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
      }
      await audit(request, principal, 'client.update', updated.id, {
        clientId: updated.clientId,
        fields: Object.keys(patch).sort(),
      });
      return reply.send(updated);
    },
  );

  app.post<{ Params: { clientId: string } }>(
    '/api/v1/clients/:clientId/secrets',
    async (request, reply) => {
      const principal = await guard(request, reply, 'idp:client:write');
      if (principal === null) {
        return reply;
      }
      const parsed = issueSecretSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendProblem(
          reply,
          422,
          'validation-error',
          'Validation failed',
          problemsDetail(parsed.error.issues.map((issue) => issue.message)),
        );
      }
      const existing = await options.clients.findByClientId(request.params.clientId);
      if (existing === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
      }
      if (existing.type === 'spa' || existing.type === 'mobile') {
        return sendProblem(
          reply,
          409,
          'conflict',
          'Conflict',
          'public clients do not hold a client secret',
        );
      }

      const secret = generateSecret();
      const expiresAt =
        parsed.data.expiresAt === undefined ? null : new Date(parsed.data.expiresAt);
      const created = await options.clients.addSecret(existing.clientId, {
        secretHash: await hash(secret),
        prefix: secret.slice(0, 12),
        expiresAt,
      });
      if (created === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
      }
      await audit(request, principal, 'client.secret.create', existing.id, {
        clientId: existing.clientId,
        secretId: created.id,
        prefix: created.prefix,
      });
      const response: { secret: ClientSecretSummary; clientSecret: string } = {
        secret: created,
        clientSecret: secret,
      };
      return reply.code(201).send(response);
    },
  );

  app.delete<{ Params: { clientId: string; secretId: string } }>(
    '/api/v1/clients/:clientId/secrets/:secretId',
    async (request, reply) => {
      const principal = await guard(request, reply, 'idp:client:write');
      if (principal === null) {
        return reply;
      }
      const revoked = await options.clients.revokeSecret(
        request.params.clientId,
        request.params.secretId,
        now(),
      );
      if (!revoked) {
        return sendProblem(
          reply,
          404,
          'not-found',
          'Not found',
          'secret does not exist or is already revoked',
        );
      }
      const owner = await options.clients.findByClientId(request.params.clientId);
      await audit(
        request,
        principal,
        'client.secret.revoke',
        owner?.id ?? request.params.clientId,
        {
          clientId: request.params.clientId,
          secretId: request.params.secretId,
        },
      );
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { clientId: string } }>(
    '/api/v1/clients/:clientId/disable',
    async (request, reply) => {
      const principal = await guard(request, reply, 'idp:client:write');
      if (principal === null) {
        return reply;
      }
      const result = await options.clients.disable(request.params.clientId, now());
      if (result === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'client does not exist');
      }
      await audit(request, principal, 'client.disable', result.client.id, {
        clientId: request.params.clientId,
        revokedCodes: result.revokedCodes,
        revokedRefreshTokens: result.revokedRefreshTokens,
        revokedSessions: result.revokedSessions,
      });
      return reply.send(result);
    },
  );
}
