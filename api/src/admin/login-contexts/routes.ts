import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AdminAudit } from '../admin-types.js';
import {
  authorizeAdminRequest,
  type AdminAuthorization,
  type AdminRequirement,
  type PermissionReader,
  type TokenVerifier,
} from '../authorize.js';
import { sendProblem } from '../routes.js';
import { loginContextInputProblems } from './login-context-validation.js';
import type {
  AdminLoginContextRepository,
  CreateLoginContextInput,
  LoginContextResult,
  UpdateLoginContextInput,
} from './login-context-types.js';

export interface LoginContextRoutesOptions {
  issuer: string;
  adminClientId: string;
  verifier: TokenVerifier;
  permissions: PermissionReader;
  contexts: AdminLoginContextRepository;
  audit: AdminAudit;
}

const CONTEXT_READ = 'idp:client-context:read';
const CONTEXT_WRITE = 'idp:client-context:write';

/** Fields whose change requires a fresh authentication (docs/login-contexts.md 6). */
const POLICY_FIELDS = ['allowedRoles', 'mfaPolicy', 'loginMethods'] as const;

const roleKeySchema = z.string().trim().min(1).max(160);
const domainSchema = z.string().trim().min(1).max(253);
const brandingSchema = z.record(z.string(), z.unknown());

const createSchema = z
  .object({
    key: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(500).nullable().default(null),
    allowedRoles: z.array(roleKeySchema).max(50).default([]),
    defaultRoles: z.array(roleKeySchema).max(50).default([]),
    loginMethods: z.array(z.string().trim().min(1).max(32)).min(1).max(5),
    mfaPolicy: z.string().trim().min(1).max(32).default('optional'),
    registrationPolicy: z.string().trim().min(1).max(32).default('invite_only'),
    allowedEmailDomains: z.array(domainSchema).max(50).default([]),
    sessionIdleTtl: z.number().int().min(60).max(86_400).default(1800),
    sessionAbsoluteTtl: z.number().int().min(300).max(2_592_000).default(28_800),
    stepUpRequired: z.boolean().default(false),
    isDefault: z.boolean().default(false),
    branding: brandingSchema.nullable().default(null),
    sortOrder: z.number().int().min(0).max(100_000).default(0),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    allowedRoles: z.array(roleKeySchema).max(50).optional(),
    defaultRoles: z.array(roleKeySchema).max(50).optional(),
    loginMethods: z.array(z.string().trim().min(1).max(32)).min(1).max(5).optional(),
    mfaPolicy: z.string().trim().min(1).max(32).optional(),
    registrationPolicy: z.string().trim().min(1).max(32).optional(),
    allowedEmailDomains: z.array(domainSchema).max(50).optional(),
    sessionIdleTtl: z.number().int().min(60).max(86_400).optional(),
    sessionAbsoluteTtl: z.number().int().min(300).max(2_592_000).optional(),
    stepUpRequired: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    branding: brandingSchema.nullable().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field is required',
  });

const validationDetail = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

const problemsDetail = (problems: string[]): string => problems.join('; ');

/**
 * The pure validator is the authority on the enum values, so the parsed strings are
 * narrowed to the documented unions only after `loginContextInputProblems` passed.
 */
const toCreateInput = (data: z.infer<typeof createSchema>): CreateLoginContextInput => ({
  ...data,
  mfaPolicy: data.mfaPolicy as CreateLoginContextInput['mfaPolicy'],
  registrationPolicy: data.registrationPolicy as CreateLoginContextInput['registrationPolicy'],
});

const toUpdateInput = (data: z.infer<typeof updateSchema>): UpdateLoginContextInput => {
  const { mfaPolicy, registrationPolicy, ...rest } = data;
  return {
    ...rest,
    ...(mfaPolicy === undefined
      ? {}
      : { mfaPolicy: mfaPolicy as CreateLoginContextInput['mfaPolicy'] }),
    ...(registrationPolicy === undefined
      ? {}
      : {
          registrationPolicy: registrationPolicy as CreateLoginContextInput['registrationPolicy'],
        }),
  };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The raw body decides step-up before full validation so a policy edit cannot slip through. */
const bodyTouchesPolicy = (body: unknown): boolean =>
  isPlainObject(body) && POLICY_FIELDS.some((field) => body[field] !== undefined);

/**
 * Login context administration (docs/api.md 3.3.3, docs/login-contexts.md 7.2).
 *
 * The path `clientId` is handed to the shared admin guard, so a delegated app admin can
 * only see or change contexts of its own app; a mismatch is rejected with `403` before any
 * row is read. Creating a context and changing its role set, MFA policy or login methods
 * require a fresh authentication (`auth_time`), and every mutation is audited with the
 * context key only.
 */
export function registerLoginContextAdminRoutes(
  app: FastifyInstance,
  options: LoginContextRoutesOptions,
): void {
  const guard = async (
    request: FastifyRequest,
    reply: FastifyReply,
    requirement: AdminRequirement,
    attempted: { action: string; contextKey?: string },
  ): Promise<{ userId: string; clientId: string } | null> => {
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
      // docs/login-contexts.md 9: a cross-context attempt is a `403` **and** an audit row.
      // The refused call is recorded before the response so the denial cannot be lost; a
      // request without a verified token carries no actor instead of a guessed one.
      await options.audit.record({
        actorType: auth.actorId === undefined ? 'anonymous' : 'admin',
        actorId: auth.actorId ?? null,
        action: 'client.context.denied',
        targetType: 'login_context',
        // `target_id` is a UUID column and a context key is not one; the key travels in
        // metadata next to the client id.
        targetId: null,
        clientId: requirement.clientId ?? null,
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
        result: 'failure',
        metadata: {
          attempted: attempted.action,
          permission: requirement.permission,
          status: auth.status,
          reason: auth.error,
          ...(attempted.contextKey === undefined ? {} : { key: attempted.contextKey }),
        },
      });
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
    principal: { userId: string },
    action:
      | 'client.context.created'
      | 'client.context.updated'
      | 'client.context.disabled'
      | 'client.context.enabled'
      | 'client.context.deleted',
    clientId: string,
    targetId: string,
    key: string,
  ): Promise<void> => {
    await options.audit.record({
      actorType: 'admin',
      actorId: principal.userId,
      action,
      targetType: 'login_context',
      targetId,
      clientId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'success',
      // The key names the changed context; role sets and policies must not be copied into
      // the append-only log (docs/login-contexts.md 6).
      metadata: { key },
    });
  };

  const failure = (
    reply: FastifyReply,
    result: Extract<LoginContextResult<unknown>, { ok: false }>,
  ) => {
    switch (result.reason) {
      case 'client-not-found':
      case 'not-found':
        return sendProblem(reply, 404, 'not-found', 'Not found', result.detail);
      default:
        return sendProblem(reply, 409, 'conflict', 'Conflict', result.detail);
    }
  };

  const validationFailure = (reply: FastifyReply, detail: string) =>
    sendProblem(reply, 422, 'validation-error', 'Validation failed', detail);

  app.get<{ Params: { clientId: string } }>(
    '/api/v1/clients/:clientId/login-contexts',
    async (request, reply) => {
      const clientId = request.params.clientId;
      if (
        (await guard(request, reply, { permission: CONTEXT_READ, clientId }, { action: 'list' })) ===
        null
      ) {
        return reply;
      }
      const result = await options.contexts.list(clientId);
      if (!result.ok) {
        return failure(reply, result);
      }
      return reply.header('Cache-Control', 'no-store').send({ items: result.value });
    },
  );

  app.post<{ Params: { clientId: string } }>(
    '/api/v1/clients/:clientId/login-contexts',
    async (request, reply) => {
      const clientId = request.params.clientId;
      const principal = await guard(
        request,
        reply,
        {
          permission: CONTEXT_WRITE,
          clientId,
          // Creating a context always sets allowedRoles/mfaPolicy/loginMethods.
          stepUp: true,
        },
        { action: 'create' },
      );
      if (principal === null) {
        return reply;
      }
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        return validationFailure(reply, validationDetail(parsed.error));
      }
      const roles = await options.contexts.roleKeys(clientId);
      if (!roles.ok) {
        return failure(reply, roles);
      }
      const problems = loginContextInputProblems(parsed.data, {
        clientId,
        clientRoleKeys: new Set(roles.value),
      });
      if (problems.length > 0) {
        return validationFailure(reply, problemsDetail(problems));
      }
      const created = await options.contexts.create(clientId, toCreateInput(parsed.data));
      if (!created.ok) {
        return failure(reply, created);
      }
      await audit(
        request,
        principal,
        'client.context.created',
        clientId,
        created.value.id,
        created.value.key,
      );
      return reply.code(201).header('Cache-Control', 'no-store').send(created.value);
    },
  );

  app.get<{ Params: { clientId: string; key: string } }>(
    '/api/v1/clients/:clientId/login-contexts/:key',
    async (request, reply) => {
      const { clientId, key } = request.params;
      if (
        (await guard(
          request,
          reply,
          { permission: CONTEXT_READ, clientId },
          { action: 'read', contextKey: key },
        )) === null
      ) {
        return reply;
      }
      const result = await options.contexts.find(clientId, key);
      if (!result.ok) {
        return failure(reply, result);
      }
      if (result.value === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'login context does not exist');
      }
      return reply.header('Cache-Control', 'no-store').send(result.value);
    },
  );

  app.patch<{ Params: { clientId: string; key: string } }>(
    '/api/v1/clients/:clientId/login-contexts/:key',
    async (request, reply) => {
      const { clientId, key } = request.params;
      const principal = await guard(
        request,
        reply,
        {
          permission: CONTEXT_WRITE,
          clientId,
          stepUp: bodyTouchesPolicy(request.body),
        },
        { action: 'update', contextKey: key },
      );
      if (principal === null) {
        return reply;
      }
      const existing = await options.contexts.find(clientId, key);
      if (!existing.ok) {
        return failure(reply, existing);
      }
      if (existing.value === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'login context does not exist');
      }
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        return validationFailure(reply, validationDetail(parsed.error));
      }
      const patch: UpdateLoginContextInput = toUpdateInput(parsed.data);

      const roles = await options.contexts.roleKeys(clientId);
      if (!roles.ok) {
        return failure(reply, roles);
      }
      // Validate the merged result, not just the patch: a PATCH that shrinks allowedRoles
      // must not leave a defaultRole outside it.
      const problems = loginContextInputProblems(
        { ...existing.value, ...patch },
        { clientId, clientRoleKeys: new Set(roles.value) },
      );
      if (problems.length > 0) {
        return validationFailure(reply, problemsDetail(problems));
      }

      const updated = await options.contexts.update(clientId, key, patch);
      if (!updated.ok) {
        return failure(reply, updated);
      }
      await audit(
        request,
        principal,
        'client.context.updated',
        clientId,
        updated.value.id,
        updated.value.key,
      );
      return reply.header('Cache-Control', 'no-store').send(updated.value);
    },
  );

  app.post<{ Params: { clientId: string; key: string } }>(
    '/api/v1/clients/:clientId/login-contexts/:key/disable',
    async (request, reply) => {
      const { clientId, key } = request.params;
      const principal = await guard(
        request,
        reply,
        { permission: CONTEXT_WRITE, clientId },
        { action: 'disable', contextKey: key },
      );
      if (principal === null) {
        return reply;
      }
      const disabled = await options.contexts.disable(clientId, key);
      if (!disabled.ok) {
        return failure(reply, disabled);
      }
      await audit(
        request,
        principal,
        'client.context.disabled',
        clientId,
        disabled.value.id,
        disabled.value.key,
      );
      return reply.header('Cache-Control', 'no-store').send(disabled.value);
    },
  );

  app.post<{ Params: { clientId: string; key: string } }>(
    '/api/v1/clients/:clientId/login-contexts/:key/enable',
    async (request, reply) => {
      const { clientId, key } = request.params;
      const principal = await guard(
        request,
        reply,
        { permission: CONTEXT_WRITE, clientId, stepUp: true },
        { action: 'enable', contextKey: key },
      );
      if (principal === null) {
        return reply;
      }
      const enabled = await options.contexts.enable(clientId, key);
      if (!enabled.ok) {
        return failure(reply, enabled);
      }
      await audit(
        request,
        principal,
        'client.context.enabled',
        clientId,
        enabled.value.id,
        enabled.value.key,
      );
      return reply.header('Cache-Control', 'no-store').send(enabled.value);
    },
  );

  app.delete<{ Params: { clientId: string; key: string } }>(
    '/api/v1/clients/:clientId/login-contexts/:key',
    async (request, reply) => {
      const { clientId, key } = request.params;
      const principal = await guard(
        request,
        reply,
        { permission: CONTEXT_WRITE, clientId },
        { action: 'delete', contextKey: key },
      );
      if (principal === null) {
        return reply;
      }
      const existing = await options.contexts.find(clientId, key);
      if (!existing.ok) {
        return failure(reply, existing);
      }
      if (existing.value === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'login context does not exist');
      }
      const removed = await options.contexts.remove(clientId, key);
      if (!removed.ok) {
        return failure(reply, removed);
      }
      await audit(
        request,
        principal,
        'client.context.deleted',
        clientId,
        existing.value.id,
        existing.value.key,
      );
      return reply.code(204).send();
    },
  );
}
