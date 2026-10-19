import type { FastifyRequest } from 'fastify';

import type { AdminPrincipal } from './admin-types.js';

/** Scope that only the global admin client is allowed to receive (docs/api.md 3). */
export const ADMIN_SCOPE = 'idp.admin';

export interface TokenVerifier {
  verify(
    token: string,
    options: { issuer: string; audience: string },
  ): Promise<Record<string, unknown>>;
}

export interface PermissionReader {
  /** Permissions the user holds through global (unscoped) role assignments. */
  globalPermissionsForUser(userId: string): Promise<string[]>;
}

export interface AdminGuardOptions {
  issuer: string;
  /** Public client id of the global admin panel; other clients can never act as admin. */
  adminClientId: string;
  verifier: TokenVerifier;
  permissions: PermissionReader;
}

export type AdminAuthorization =
  | { ok: true; principal: AdminPrincipal }
  | {
      ok: false;
      status: 401 | 403;
      error: 'invalid_token' | 'insufficient_scope' | 'forbidden';
      message: string;
    };

/** Extracts the bearer token from an `Authorization` header. */
export function readBearerToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Authorizes an Admin API request (docs/api.md 3, docs/security.md 4).
 *
 * The token proves *who* is calling and which client they used; permissions are always read
 * from the database so a revoked role takes effect immediately instead of when the token
 * expires. Every failure is reported without revealing whether the user, the client or the
 * permission was the missing piece.
 */
export async function authorizeAdminRequest(
  request: FastifyRequest,
  options: AdminGuardOptions,
  permission: string,
): Promise<AdminAuthorization> {
  const token = readBearerToken(request.headers.authorization);
  if (token === null) {
    return { ok: false, status: 401, error: 'invalid_token', message: 'bearer token required' };
  }

  let payload: Record<string, unknown>;
  try {
    payload = await options.verifier.verify(token, {
      issuer: options.issuer,
      audience: options.adminClientId,
    });
  } catch {
    return { ok: false, status: 401, error: 'invalid_token', message: 'token is not valid' };
  }

  const subject = typeof payload['sub'] === 'string' ? payload['sub'] : '';
  const clientId = typeof payload['client_id'] === 'string' ? payload['client_id'] : '';
  if (subject === '' || clientId === '') {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      message: 'token claims are incomplete',
    };
  }
  if (clientId !== options.adminClientId) {
    return {
      ok: false,
      status: 403,
      error: 'insufficient_scope',
      message: 'token was issued to a different client',
    };
  }

  const scopes =
    typeof payload['scope'] === 'string' ? payload['scope'].split(' ').filter(Boolean) : [];
  if (!scopes.includes(ADMIN_SCOPE)) {
    return {
      ok: false,
      status: 403,
      error: 'insufficient_scope',
      message: `scope ${ADMIN_SCOPE} is required`,
    };
  }

  const held = await options.permissions.globalPermissionsForUser(subject);
  const permissions = new Set(held);
  if (!permissions.has(permission)) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      message: `permission ${permission} is required`,
    };
  }

  return { ok: true, principal: { userId: subject, clientId, scopes, permissions } };
}
