import { verifyPassword, type Argon2Params, DEFAULT_ARGON2_PARAMS } from '../auth/password.js';

export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

export interface AuthenticatedClient {
  clientId: string;
  requirePkce: boolean;
  accessTokenTtl: number;
  refreshTokenTtl: number;
  scopes: string[];
  type: 'web' | 'spa' | 'mobile' | 'm2m';
}

export interface ClientAuthClientRecord extends AuthenticatedClient {
  status: 'active' | 'disabled';
  /** Active, non-revoked secret hashes (Argon2id PHC strings). */
  secretHashes: string[];
}

export interface ClientAuthRepository {
  findForAuth(clientId: string): Promise<ClientAuthClientRecord | null>;
}

export type ClientAuthFailure =
  'invalid_client' | 'invalid_client_secret' | 'client_disabled' | 'secret_required';

export type ClientAuthResult =
  { ok: true; client: AuthenticatedClient } | { ok: false; reason: ClientAuthFailure };

export interface ClientAuthInput {
  clientId?: string;
  clientSecret?: string;
  method: ClientAuthMethod;
  params?: Argon2Params;
}

/**
 * Authenticates a token endpoint caller.
 *
 * - `client_secret_basic` / `client_secret_post`: secret verified against every active hash.
 * - `none`: only allowed for public clients (`spa`, `mobile`), which must use PKCE.
 */
export async function authenticateClient(
  repository: ClientAuthRepository,
  input: ClientAuthInput,
): Promise<ClientAuthResult> {
  if (input.clientId === undefined || input.clientId === '') {
    return { ok: false, reason: 'invalid_client' };
  }

  const client = await repository.findForAuth(input.clientId);
  if (client === null || client.status !== 'active') {
    return { ok: false, reason: 'invalid_client' };
  }

  if (input.method === 'none') {
    if (client.type !== 'spa' && client.type !== 'mobile') {
      return { ok: false, reason: 'secret_required' };
    }
    return { ok: true, client: toAuthenticatedClient(client) };
  }

  if (input.clientSecret === undefined || input.clientSecret === '') {
    return { ok: false, reason: 'secret_required' };
  }

  const params = input.params ?? DEFAULT_ARGON2_PARAMS;
  for (const hash of client.secretHashes) {
    if (await verifyPassword(hash, input.clientSecret, params)) {
      return { ok: true, client: toAuthenticatedClient(client) };
    }
  }
  return { ok: false, reason: 'invalid_client_secret' };
}

/** Parses an `Authorization: Basic` header into a client id and secret. */
export function parseBasicAuthHeader(header: string | undefined): {
  clientId: string;
  clientSecret: string;
} | null {
  if (header === undefined) {
    return null;
  }
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (match?.[1] === undefined) {
    return null;
  }
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) {
    return null;
  }
  return {
    clientId: decodeURIComponent(decoded.slice(0, separator)),
    clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
  };
}

function toAuthenticatedClient(client: ClientAuthClientRecord): AuthenticatedClient {
  return {
    clientId: client.clientId,
    requirePkce: client.requirePkce,
    accessTokenTtl: client.accessTokenTtl,
    refreshTokenTtl: client.refreshTokenTtl,
    scopes: client.scopes,
    type: client.type,
  };
}
