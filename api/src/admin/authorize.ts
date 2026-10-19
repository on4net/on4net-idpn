import type { FastifyRequest } from 'fastify';

import type { AdminPrincipal } from './admin-types.js';

/** Scope that only the global admin client is allowed to receive (docs/api.md 3). */
export const ADMIN_SCOPE = 'idp.admin';
/** Scope that lets an app administer its own members and roles (docs/api.md 3). */
export const CLIENT_ADMIN_SCOPE = 'idp.client-admin';
/** Step-up window for sensitive delegated operations. */
export const STEP_UP_MAX_AGE_SECONDS = 300;

export interface TokenVerifier {
  verify(
    token: string,
    options: { issuer: string; audience: string },
  ): Promise<Record<string, unknown>>;
}

export interface PermissionReader {
  /** Permissions the user holds through global (unscoped) role assignments. */
  globalPermissionsForUser(userId: string): Promise<string[]>;
  /**
   * `idp:client-*` permissions the user holds for one app through global assignments of
   * global or app-owned roles.
   */
  clientPermissionsForUser?(userId: string, clientId: string): Promise<string[]>;
}

export interface AdminGuardOptions {
  issuer: string;
  /** Public client id of the global admin panel; other clients can never act as admin. */
  adminClientId: string;
  verifier: TokenVerifier;
  permissions: PermissionReader;
  now?: () => Date;
  stepUpMaxAgeSeconds?: number;
}

export interface AdminRequirement {
  /** Fine-grained permission required for a Global Admin call. */
  permission: string;
  /** Permission required instead when the caller uses a delegated token. */
  delegatedPermission?: string;
  /** Public client id of the target resource; a delegated token must match it. */
  clientId?: string;
  /** Accept a delegated token even when the target client is resolved later from the body. */
  allowDelegated?: boolean;
  /** Requires an authentication newer than `stepUpMaxAgeSeconds`. */
  stepUp?: boolean;
}

export type AdminAuthorization =
  | { ok: true; principal: AdminPrincipal }
  | {
      ok: false;
      status: 401 | 403;
      error:
        'invalid_token' | 'insufficient_scope' | 'forbidden' | 'insufficient_user_authentication';
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
 * Reads the `client_id` claim without verifying the signature. The value is only used to
 * choose which audience to verify against; the verifier still enforces signature, issuer
 * and audience, and the claim is checked again afterwards.
 */
function readClientIdClaim(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return typeof payload['client_id'] === 'string' ? payload['client_id'] : null;
  } catch {
    return null;
  }
}

const denied = (
  status: 401 | 403,
  error: Extract<AdminAuthorization, { ok: false }>['error'],
  message: string,
): AdminAuthorization => ({ ok: false, status, error, message });

/**
 * Authorizes an Admin API request (docs/api.md 3, docs/security.md 4).
 *
 * Two token modes are supported:
 *
 * - **Global Admin** — `aud = admin-panel`, scope `idp.admin`, permissions read from global
 *   assignments. It may act on any client.
 * - **Delegated Admin** — `aud = client_id = <app>`, scope `idp.client-admin`, permissions
 *   limited to `idp:client-*` for that app. A request for another client always fails.
 *
 * Permissions are always read from the database so a revoked role takes effect immediately
 * instead of when the token expires. Failures never reveal which of user, client or
 * permission was missing.
 */
export async function authorizeAdminRequest(
  request: FastifyRequest,
  options: AdminGuardOptions,
  rawRequirement: string | AdminRequirement,
): Promise<AdminAuthorization> {
  const requirement =
    typeof rawRequirement === 'string' ? { permission: rawRequirement } : rawRequirement;

  const token = readBearerToken(request.headers.authorization);
  if (token === null) {
    return denied(401, 'invalid_token', 'bearer token required');
  }

  const claimedClientId = readClientIdClaim(token);
  const delegatedPossible =
    (requirement.allowDelegated === true || requirement.clientId !== undefined) &&
    claimedClientId !== null &&
    claimedClientId !== options.adminClientId;

  let payload: Record<string, unknown>;
  let delegated: boolean;
  if (delegatedPossible) {
    try {
      payload = await options.verifier.verify(token, {
        issuer: options.issuer,
        audience: claimedClientId,
      });
    } catch {
      return denied(401, 'invalid_token', 'token is not valid');
    }
    if (payload['client_id'] !== claimedClientId) {
      return denied(401, 'invalid_token', 'token claims are incomplete');
    }
    delegated = true;
  } else {
    try {
      payload = await options.verifier.verify(token, {
        issuer: options.issuer,
        audience: options.adminClientId,
      });
    } catch {
      return denied(401, 'invalid_token', 'token is not valid');
    }
    delegated = false;
  }

  const subject = typeof payload['sub'] === 'string' ? payload['sub'] : '';
  const clientId = typeof payload['client_id'] === 'string' ? payload['client_id'] : '';
  if (subject === '' || clientId === '') {
    return denied(401, 'invalid_token', 'token claims are incomplete');
  }

  const scopes =
    typeof payload['scope'] === 'string' ? payload['scope'].split(' ').filter(Boolean) : [];

  if (!delegated) {
    if (clientId !== options.adminClientId) {
      return denied(403, 'insufficient_scope', 'token was issued to a different client');
    }
    if (!scopes.includes(ADMIN_SCOPE)) {
      return denied(403, 'insufficient_scope', `scope ${ADMIN_SCOPE} is required`);
    }
  } else {
    if (requirement.clientId !== undefined && clientId !== requirement.clientId) {
      return denied(403, 'insufficient_scope', 'token was issued to a different client');
    }
    if (!scopes.includes(CLIENT_ADMIN_SCOPE)) {
      return denied(403, 'insufficient_scope', `scope ${CLIENT_ADMIN_SCOPE} is required`);
    }
    const delegatedPermission = requirement.delegatedPermission ?? requirement.permission;
    if (!delegatedPermission.startsWith('idp:client-')) {
      return denied(403, 'forbidden', 'delegated tokens cannot perform this operation');
    }
    if (options.permissions.clientPermissionsForUser === undefined) {
      return denied(403, 'forbidden', 'delegated administration is not configured');
    }
  }

  if (requirement.stepUp === true) {
    const maxAge = options.stepUpMaxAgeSeconds ?? STEP_UP_MAX_AGE_SECONDS;
    const nowSeconds = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
    const authTime = typeof payload['auth_time'] === 'number' ? payload['auth_time'] : 0;
    if (authTime <= 0 || nowSeconds - authTime > maxAge) {
      return denied(
        403,
        'insufficient_user_authentication',
        'recent authentication is required for this operation',
      );
    }
  }

  const requiredPermission = delegated
    ? (requirement.delegatedPermission ?? requirement.permission)
    : requirement.permission;
  const held = delegated
    ? await options.permissions.clientPermissionsForUser!(subject, clientId)
    : await options.permissions.globalPermissionsForUser(subject);
  const permissionSet = new Set(held);
  if (!permissionSet.has(requiredPermission)) {
    return denied(403, 'forbidden', `permission ${requiredPermission} is required`);
  }

  return {
    ok: true,
    principal: {
      userId: subject,
      clientId,
      scopes,
      permissions: permissionSet,
      mode: delegated ? 'delegated' : 'global',
    },
  };
}
