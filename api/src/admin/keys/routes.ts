import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AdminAudit } from '../admin-types.js';
import {
  authorizeAdminRequest,
  type AdminAuthorization,
  type PermissionReader,
  type TokenVerifier,
} from '../authorize.js';
import { sendProblem } from '../routes.js';
import type { KeyRotationResult } from '../../oidc/key-types.js';
import type { SigningKeyManager } from '../../oidc/keys.js';

export const KEY_READ_PERMISSION = 'idp:key:read';
export const KEY_WRITE_PERMISSION = 'idp:key:write';

export interface KeyRoutesOptions {
  issuer: string;
  adminClientId: string;
  verifier: TokenVerifier;
  permissions: PermissionReader;
  keys: SigningKeyManager;
  audit: AdminAudit;
}

/** Emergency rotation after a suspected key compromise. */
const rotateSchema = z.object({
  revokePrevious: z.boolean().optional(),
});

/**
 * Registers the signing-key endpoints (docs/api.md 3.9).
 *
 * `GET /api/v1/keys` reports public metadata and rotation health only; private key
 * material is never serialized, not even for Global Admin. `POST /api/v1/keys/rotate`
 * performs a normal rotation (old key retired and kept in JWKS for the overlap window) or,
 * with `{ "revokePrevious": true }`, an emergency rotation that revokes the old key.
 */
export function registerKeyAdminRoutes(app: FastifyInstance, options: KeyRoutesOptions): void {
  const guard = async (
    request: FastifyRequest,
    reply: FastifyReply,
    requirement: string | { permission: string; stepUp?: boolean },
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
      if (auth.status === 401) {
        reply.header('WWW-Authenticate', 'Bearer "invalid_token"');
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
    result: KeyRotationResult,
    trigger: 'manual' | 'emergency',
  ): Promise<void> => {
    await options.audit.record({
      actorType: 'admin',
      actorId: principal.userId,
      action: 'key.rotate',
      // `audit_events.target_id` is a UUID column; the signing `kid` is a JWK thumbprint,
      // so it is recorded in metadata instead. No key material is ever included.
      targetType: 'signing_key',
      targetId: null,
      clientId: principal.clientId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'success',
      metadata: {
        kid: result.active.kid,
        previousKid: result.previousKid,
        previousRevoked: result.previousRevoked,
        trigger,
      },
    });
  };

  app.get('/api/v1/keys', async (request, reply) => {
    if ((await guard(request, reply, KEY_READ_PERMISSION)) === null) {
      return reply;
    }
    const health = await options.keys.inspect();
    return reply.header('Cache-Control', 'no-store').send({
      keys: health.keys.map((key) => ({
        kid: key.kid,
        alg: key.alg,
        status: key.status,
        createdAt: key.createdAt.toISOString(),
        retiredAt: key.retiredAt?.toISOString() ?? null,
        publishedInJwks: key.publishedInJwks,
      })),
      activeKey:
        health.activeKey === null
          ? null
          : {
              kid: health.activeKey.kid,
              createdAt: health.activeKey.createdAt.toISOString(),
              ageDays: health.activeKey.ageDays,
            },
      rotationDue: health.rotationDue,
      rotationDueAfterDays: health.rotationDueAfterDays,
    });
  });

  app.post('/api/v1/keys/rotate', async (request, reply) => {
    // `revokePrevious` invalidates every issued token, so the operation needs a fresh
    // authentication on top of the permission (docs/security.md 191/328).
    const principal = await guard(request, reply, {
      permission: KEY_WRITE_PERMISSION,
      stepUp: true,
    });
    if (principal === null) {
      return reply;
    }
    const parsed = rotateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        '/api/v1/keys/rotate',
      );
    }

    const revokePrevious = parsed.data.revokePrevious === true;
    const result = await options.keys.rotate({ revokePrevious });
    await audit(request, principal, result, revokePrevious ? 'emergency' : 'manual');

    return reply.header('Cache-Control', 'no-store').send({
      activeKey: {
        kid: result.active.kid,
        alg: result.active.alg,
        status: result.active.status,
        createdAt: result.active.createdAt.toISOString(),
      },
      previousKid: result.previousKid,
      previousRevoked: result.previousRevoked,
    });
  });
}
