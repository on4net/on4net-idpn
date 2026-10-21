import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AdminAudit } from '../admin-types.js';
import {
  authorizeAdminRequest,
  type AdminAuthorization,
  type AdminRequirement,
  type PermissionReader,
  type TokenVerifier,
} from '../authorize.js';
import { sendProblem } from '../routes.js';
import {
  catalogQuerySchema,
  createPermissionSchema,
  createRoleSchema,
  replaceRolePermissionsSchema,
  updateRoleSchema,
} from './rbac-schemas.js';
import type { AdminRbacRepository, CatalogResult } from './rbac-types.js';
import { permissionKeyProblems, roleKeyProblems } from './rbac-validation.js';

export interface RbacRoutesOptions {
  issuer: string;
  adminClientId: string;
  verifier: TokenVerifier;
  permissions: PermissionReader;
  rbac: AdminRbacRepository;
  audit: AdminAudit;
}

const READ_PERMISSION = 'idp:role:read';
const WRITE_PERMISSION = 'idp:role:write';
const DELEGATED_READ = 'idp:client-role:read';
const DELEGATED_WRITE = 'idp:client-role:write';

type GuardedPrincipal = { userId: string; clientId: string; mode: 'global' | 'delegated' };

const validationDetail = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

const forbidden = (reply: FastifyReply, detail: string): FastifyReply =>
  sendProblem(reply, 403, 'forbidden', 'Forbidden', detail);

/** Registers the permission catalog and role endpoints (docs/api.md 3.4). */
export function registerRbacAdminRoutes(app: FastifyInstance, options: RbacRoutesOptions): void {
  const authorize = async (
    request: FastifyRequest,
    reply: FastifyReply,
    requirement: string | AdminRequirement,
  ): Promise<GuardedPrincipal | null> => {
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
    return {
      userId: auth.principal.userId,
      clientId: auth.principal.clientId,
      mode: auth.principal.mode,
    };
  };

  const audit = async (
    request: FastifyRequest,
    principal: { userId: string; clientId: string },
    action: string,
    targetType: 'permission' | 'role',
    targetId: string,
    targetClientId: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> => {
    await options.audit.record({
      actorType: 'admin',
      actorId: principal.userId,
      action,
      targetType,
      targetId,
      clientId: targetClientId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'success',
      metadata,
    });
  };

  const sendFailure = (
    reply: FastifyReply,
    result: Extract<CatalogResult<unknown>, { ok: false }>,
  ) => {
    switch (result.reason) {
      case 'client-not-found':
      case 'not-found':
        return sendProblem(reply, 404, 'not-found', 'Not found', result.detail);
      case 'duplicate-key':
      case 'in-use':
        return sendProblem(reply, 409, 'conflict', 'Conflict', result.detail);
      default:
        return sendProblem(reply, 422, 'validation-error', 'Validation failed', result.detail);
    }
  };

  app.get('/api/v1/permissions', async (request, reply) => {
    const principal = await authorize(request, reply, {
      permission: READ_PERMISSION,
      delegatedPermission: DELEGATED_READ,
      allowDelegated: true,
    });
    if (principal === null) {
      return reply;
    }
    const parsed = catalogQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        validationDetail(parsed.error),
      );
    }
    const { page, limit, clientId, q } = parsed.data;
    if (
      principal.mode === 'delegated' &&
      clientId !== undefined &&
      clientId !== principal.clientId
    ) {
      return forbidden(reply, 'token was issued to a different client');
    }
    const scopedClientId = principal.mode === 'delegated' ? principal.clientId : clientId;
    const result = await options.rbac.listPermissions({
      page,
      limit,
      ...(scopedClientId === undefined ? {} : { clientId: scopedClientId }),
      ...(q === undefined ? {} : { query: q }),
    });
    return reply.send({ items: result.items, page, limit, total: result.total });
  });

  app.post('/api/v1/permissions', async (request, reply) => {
    const principal = await authorize(request, reply, {
      permission: WRITE_PERMISSION,
      delegatedPermission: DELEGATED_WRITE,
      allowDelegated: true,
    });
    if (principal === null) {
      return reply;
    }
    const parsed = createPermissionSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        validationDetail(parsed.error),
      );
    }
    const body = parsed.data;
    if (principal.mode === 'delegated' && body.clientId !== principal.clientId) {
      return forbidden(reply, 'token was issued to a different client');
    }
    const keyProblems = permissionKeyProblems(body.key, body.clientId);
    if (keyProblems.length > 0) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        keyProblems.join('; '),
      );
    }

    const created = await options.rbac.createPermission(body);
    if (!created.ok) {
      return sendFailure(reply, created);
    }
    await audit(
      request,
      principal,
      'permission.create',
      'permission',
      created.value.id,
      created.value.clientId,
      { key: created.value.key },
    );
    return reply.code(201).send(created.value);
  });

  app.delete<{ Params: { id: string } }>('/api/v1/permissions/:id', async (request, reply) => {
    const principal = await authorize(request, reply, {
      permission: WRITE_PERMISSION,
      delegatedPermission: DELEGATED_WRITE,
      allowDelegated: true,
    });
    if (principal === null) {
      return reply;
    }
    const permission = await options.rbac.findPermission(request.params.id);
    if (permission === null) {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'permission does not exist');
    }
    if (principal.mode === 'delegated' && permission.clientId !== principal.clientId) {
      return forbidden(reply, 'token was issued to a different client');
    }
    const outcome = await options.rbac.deletePermission(request.params.id);
    if (outcome === 'not-found') {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'permission does not exist');
    }
    if (outcome === 'in-use') {
      return sendProblem(
        reply,
        409,
        'conflict',
        'Conflict',
        'permission is still linked to a role',
      );
    }
    await audit(
      request,
      principal,
      'permission.delete',
      'permission',
      request.params.id,
      permission.clientId,
    );
    return reply.code(204).send();
  });

  app.get('/api/v1/roles', async (request, reply) => {
    const principal = await authorize(request, reply, {
      permission: READ_PERMISSION,
      delegatedPermission: DELEGATED_READ,
      allowDelegated: true,
    });
    if (principal === null) {
      return reply;
    }
    const parsed = catalogQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        validationDetail(parsed.error),
      );
    }
    const { page, limit, clientId, q } = parsed.data;
    if (
      principal.mode === 'delegated' &&
      clientId !== undefined &&
      clientId !== principal.clientId
    ) {
      return forbidden(reply, 'token was issued to a different client');
    }
    const scopedClientId = principal.mode === 'delegated' ? principal.clientId : clientId;
    const result = await options.rbac.listRoles({
      page,
      limit,
      ...(scopedClientId === undefined ? {} : { clientId: scopedClientId }),
      ...(q === undefined ? {} : { query: q }),
    });
    return reply.send({ items: result.items, page, limit, total: result.total });
  });

  app.post('/api/v1/roles', async (request, reply) => {
    const principal = await authorize(request, reply, {
      permission: WRITE_PERMISSION,
      delegatedPermission: DELEGATED_WRITE,
      allowDelegated: true,
    });
    if (principal === null) {
      return reply;
    }
    const parsed = createRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        validationDetail(parsed.error),
      );
    }
    const body = parsed.data;
    if (principal.mode === 'delegated' && body.clientId !== principal.clientId) {
      return forbidden(reply, 'token was issued to a different client');
    }
    const keyProblems = roleKeyProblems(body.key, body.clientId);
    if (keyProblems.length > 0) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        keyProblems.join('; '),
      );
    }

    const created = await options.rbac.createRole(
      {
        key: body.key,
        name: body.name,
        description: body.description,
        clientId: body.clientId,
        isDefault: body.isDefault,
        permissionKeys: body.permissions,
      },
      { allowGlobalPermissions: principal.mode === 'global' },
    );
    if (!created.ok) {
      return sendFailure(reply, created);
    }
    await audit(
      request,
      principal,
      'role.create',
      'role',
      created.value.id,
      created.value.clientId,
      { key: created.value.key, permissions: created.value.permissionKeys },
    );
    return reply.code(201).send(created.value);
  });

  app.get<{ Params: { id: string } }>('/api/v1/roles/:id', async (request, reply) => {
    const principal = await authorize(request, reply, {
      permission: READ_PERMISSION,
      delegatedPermission: DELEGATED_READ,
      allowDelegated: true,
    });
    if (principal === null) {
      return reply;
    }
    const role = await options.rbac.findRole(request.params.id);
    if (role === null) {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'role does not exist');
    }
    if (principal.mode === 'delegated' && role.clientId !== principal.clientId) {
      return forbidden(reply, 'token was issued to a different client');
    }
    return reply.send(role);
  });

  app.patch<{ Params: { id: string } }>('/api/v1/roles/:id', async (request, reply) => {
    const principal = await authorize(request, reply, {
      permission: WRITE_PERMISSION,
      delegatedPermission: DELEGATED_WRITE,
      allowDelegated: true,
    });
    if (principal === null) {
      return reply;
    }
    const parsed = updateRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        validationDetail(parsed.error),
      );
    }
    const existing = await options.rbac.findRole(request.params.id);
    if (existing === null) {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'role does not exist');
    }
    if (principal.mode === 'delegated' && existing.clientId !== principal.clientId) {
      return forbidden(reply, 'token was issued to a different client');
    }
    const updated = await options.rbac.updateRole(request.params.id, parsed.data);
    if (!updated.ok) {
      return sendFailure(reply, updated);
    }
    await audit(
      request,
      principal,
      'role.update',
      'role',
      updated.value.id,
      updated.value.clientId,
      { fields: Object.keys(parsed.data).sort() },
    );
    return reply.send(updated.value);
  });

  app.put<{ Params: { id: string } }>('/api/v1/roles/:id/permissions', async (request, reply) => {
    const principal = await authorize(request, reply, {
      permission: WRITE_PERMISSION,
      delegatedPermission: DELEGATED_WRITE,
      // Replacing the permission set changes what every holder of the role can do, exactly
      // like deleting the role, so it needs the same fresh authentication.
      stepUp: true,
      allowDelegated: true,
    });
    if (principal === null) {
      return reply;
    }
    const parsed = replaceRolePermissionsSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        validationDetail(parsed.error),
      );
    }
    const existing = await options.rbac.findRole(request.params.id);
    if (existing === null) {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'role does not exist');
    }
    if (principal.mode === 'delegated' && existing.clientId !== principal.clientId) {
      return forbidden(reply, 'token was issued to a different client');
    }
    const updated = await options.rbac.replaceRolePermissions(
      request.params.id,
      parsed.data.permissions,
      { allowGlobalPermissions: principal.mode === 'global' },
    );
    if (!updated.ok) {
      return sendFailure(reply, updated);
    }
    await audit(
      request,
      principal,
      'role.permissions.replace',
      'role',
      updated.value.id,
      updated.value.clientId,
      { permissions: updated.value.permissionKeys },
    );
    return reply.send(updated.value);
  });

  app.delete<{ Params: { id: string } }>('/api/v1/roles/:id', async (request, reply) => {
    const principal = await authorize(request, reply, {
      permission: WRITE_PERMISSION,
      delegatedPermission: DELEGATED_WRITE,
      allowDelegated: true,
      stepUp: true,
    });
    if (principal === null) {
      return reply;
    }
    const role = await options.rbac.findRole(request.params.id);
    if (role === null) {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'role does not exist');
    }
    if (principal.mode === 'delegated' && role.clientId !== principal.clientId) {
      return forbidden(reply, 'token was issued to a different client');
    }
    const outcome = await options.rbac.deleteRole(request.params.id);
    if (outcome === 'in-use') {
      return sendProblem(
        reply,
        409,
        'conflict',
        'Conflict',
        'role still has assignments and cannot be deleted',
      );
    }
    await audit(request, principal, 'role.delete', 'role', role.id, role.clientId, {
      key: role.key,
    });
    return reply.code(204).send();
  });
}
