import { defaultClientSecretService, type ClientSecretService } from '../auth/client-secret.js';

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
  /**
   * Active, non-revoked secret hashes: `v2$<pepperId>$<digest>` (keyed HMAC) or a legacy
   * `$argon2id$` PHC string (`docs/client-secret-hashing.md`).
   */
  secretHashes: string[];
}

export interface ClientAuthRepository {
  findForAuth(clientId: string): Promise<ClientAuthClientRecord | null>;
  /**
   * Replaces a superseded secret hash after a successful verification (legacy Argon2id or a
   * rotated pepper). Optional: read-only repositories may omit it, and a failure here must
   * never fail the authentication that already succeeded.
   */
  rehashSecret?(clientId: string, previousHash: string, nextHash: string): Promise<void>;
}

export type ClientAuthFailure =
  'invalid_client' | 'invalid_client_secret' | 'client_disabled' | 'secret_required';

export type ClientAuthResult =
  { ok: true; client: AuthenticatedClient } | { ok: false; reason: ClientAuthFailure };

export interface ClientAuthInput {
  clientId?: string;
  clientSecret?: string;
  method: ClientAuthMethod;
  /** Defaults to the service built from the process environment. */
  clientSecrets?: ClientSecretService;
}

/**
 * Authenticates a token endpoint caller.
 *
 * - `client_secret_basic` / `client_secret_post`: the secret is verified against every active
 *   hash with the keyed-HMAC scheme (constant time); legacy Argon2id rows still verify and are
 *   upgraded in place on success so the slow path disappears after the first rotation.
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

  const secrets = input.clientSecrets ?? defaultClientSecretService();
  for (const hash of client.secretHashes) {
    const verification = await secrets.verify(input.clientSecret, hash);
    if (!verification.valid) {
      continue;
    }
    if (verification.needsRehash) {
      await rehash(repository, client.clientId, hash, secrets.hash(input.clientSecret));
    }
    return { ok: true, client: toAuthenticatedClient(client) };
  }
  return { ok: false, reason: 'invalid_client_secret' };
}

/**
 * Opportunistic upgrade of a legacy/rotated hash. Idempotent (the target hash is deterministic
 * for a given pepper) and best effort: a database hiccup must not turn a valid credential into
 * a failed login, so the error is swallowed and the next request retries.
 */
async function rehash(
  repository: ClientAuthRepository,
  clientId: string,
  previousHash: string,
  nextHash: string,
): Promise<void> {
  if (repository.rehashSecret === undefined) {
    return;
  }
  try {
    await repository.rehashSecret(clientId, previousHash, nextHash);
  } catch {
    // Deliberately ignored; verification already succeeded.
  }
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
