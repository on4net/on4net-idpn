import { createHmac, timingSafeEqual } from 'node:crypto';

import { verifyPassword } from './password.js';

/**
 * Client-secret storage (docs/client-secret-hashing.md).
 *
 * Client secrets are machine-generated (32 random bytes, base64url — 256 bits of entropy),
 * never chosen by a human and never reused across clients. There is no dictionary to search
 * and no offline guessing risk comparable to a password, so a memory-hard, deliberately slow
 * password hash is the wrong tool: it made every `/token` request pay ~120-150ms of Argon2id
 * and saturated the libuv worker pool at the documented 20 client-authenticated requests/s
 * (issue #68).
 *
 * Secrets are therefore stored as `v2$<pepperId>$<base64url(HMAC-SHA-256(pepper, secret))>`.
 * The keyed digest still protects a leaked database dump: without the pepper (KMS/Vault, never
 * in PostgreSQL) the digest cannot be recomputed. Verification compares the raw 32-byte
 * digests in constant time and the pepper id makes pepper rotation possible without a
 * flag day. User passwords keep Argon2id (`auth/password.ts`).
 *
 * Legacy `$argon2id$...` rows keep working: they are verified with Argon2id and, on the first
 * successful verification, the row is rewritten to the v2 format (opportunistically, by the
 * caller). There is no offline migration because the plaintext is not stored anywhere.
 */

/** Version tag of the current hash format. A future scheme gets its own tag. */
export const CLIENT_SECRET_HASH_VERSION = 'v2';

const ARGON2ID_PREFIX = '$argon2id$';
const DIGEST_BYTES = 32;
const MIN_PEPPER_LENGTH = 32;
const PEPPER_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

/**
 * Development/test pepper. Not a secret: it only keeps local runs working when
 * `CLIENT_SECRET_PEPPER` is unset. Production refuses to start instead.
 */
export const DEV_CLIENT_SECRET_PEPPER = 'idpn-development-client-secret-pepper-not-for-production';
export const DEV_CLIENT_SECRET_PEPPER_ID = 'dev';

export interface ClientSecretPepper {
  /** Short, public identifier stored with the hash so rotation can be staged. */
  id: string;
  value: Buffer;
}

export interface ClientSecretPeppers {
  /** Pepper used for new hashes. */
  current: ClientSecretPepper;
  /** Superseded peppers still accepted during a rotation window. Never used to write. */
  previous: ClientSecretPepper[];
}

export interface ClientSecretVerification {
  valid: boolean;
  /**
   * True when the stored hash should be replaced by a hash of the current pepper/format.
   * Set only after a successful verification, so a rehash can never lock a client out.
   */
  needsRehash: boolean;
}

export interface ClientSecretService {
  /** Public id of the pepper used for new hashes (never the pepper itself). */
  readonly pepperId: string;
  hash(secret: string): string;
  verify(secret: string, storedHash: string): Promise<ClientSecretVerification>;
}

/** Raised for an invalid pepper configuration. Messages never contain a pepper value. */
export class ClientSecretConfigError extends Error {
  override readonly name = 'ClientSecretConfigError';
}

const digest = (secret: string, pepper: ClientSecretPepper): Buffer =>
  createHmac('sha256', pepper.value).update(secret, 'utf8').digest();

/** Computes the current-format hash. Deterministic, so seeding stays idempotent. */
export function hashClientSecret(secret: string, peppers: ClientSecretPeppers): string {
  const value = digest(secret, peppers.current).toString('base64url');
  return `${CLIENT_SECRET_HASH_VERSION}$${peppers.current.id}$${value}`;
}

const findPepper = (peppers: ClientSecretPeppers, id: string): ClientSecretPepper | undefined =>
  peppers.current.id === id ? peppers.current : peppers.previous.find((pepper) => pepper.id === id);

async function verifyInternal(
  secret: string,
  storedHash: string,
  peppers: ClientSecretPeppers,
): Promise<ClientSecretVerification> {
  if (storedHash.startsWith(`${CLIENT_SECRET_HASH_VERSION}$`)) {
    const parts = storedHash.split('$');
    if (parts.length !== 3) {
      return { valid: false, needsRehash: false };
    }
    const [, pepperId, encoded] = parts;
    const pepper = pepperId === undefined ? undefined : findPepper(peppers, pepperId);
    // Compute the digest even for an unknown pepper id so a malformed row does not become
    // observably cheaper than a valid one.
    const expected = digest(secret, pepper ?? peppers.current);
    const presented = Buffer.from(encoded ?? '', 'base64url');
    const valid =
      pepper !== undefined &&
      presented.length === DIGEST_BYTES &&
      timingSafeEqual(presented, expected);
    return {
      valid,
      needsRehash: valid && pepper !== undefined && pepper.id !== peppers.current.id,
    };
  }

  if (storedHash.startsWith(ARGON2ID_PREFIX)) {
    // Legacy client secrets were hashed with `hashPassword(plain)` (default parameters, no
    // pepper), so the PHC string carries everything verification needs.
    const valid = await verifyPassword(storedHash, secret);
    return { valid, needsRehash: valid };
  }

  // Unknown format or version: fail closed. A client must rotate its secret, and the error
  // path is identical to a wrong secret (no format enumeration).
  return { valid: false, needsRehash: false };
}

/** Verifies a presented secret against a stored hash without leaking timing. */
export function verifyClientSecret(
  secret: string,
  storedHash: string,
  peppers: ClientSecretPeppers,
): Promise<ClientSecretVerification> {
  return verifyInternal(secret, storedHash, peppers);
}

export function createClientSecretService(peppers: ClientSecretPeppers): ClientSecretService {
  return {
    pepperId: peppers.current.id,
    hash: (secret) => hashClientSecret(secret, peppers),
    verify: (secret, storedHash) => verifyClientSecret(secret, storedHash, peppers),
  };
}

export interface ClientSecretPepperEnv {
  NODE_ENV?: string | undefined;
  CLIENT_SECRET_PEPPER?: string | undefined;
  CLIENT_SECRET_PEPPER_ID?: string | undefined;
  CLIENT_SECRET_PREVIOUS_PEPPERS?: string | undefined;
}

function parsePepperId(id: string, key: string): string {
  const trimmed = id.trim();
  if (!PEPPER_ID_PATTERN.test(trimmed)) {
    throw new ClientSecretConfigError(
      `${key} must be 1-16 characters of letters, digits, dash or underscore`,
    );
  }
  return trimmed;
}

function parsePepperValue(value: string, key: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.length < MIN_PEPPER_LENGTH) {
    throw new ClientSecretConfigError(`${key} must be at least ${MIN_PEPPER_LENGTH} characters`);
  }
  return Buffer.from(trimmed, 'utf8');
}

function parsePreviousPeppers(raw: string | undefined): ClientSecretPepper[] {
  const value = raw?.trim();
  if (value === undefined || value === '') {
    return [];
  }
  const peppers: ClientSecretPepper[] = [];
  for (const entry of value.split(',')) {
    const separator = entry.indexOf(':');
    if (separator === -1) {
      throw new ClientSecretConfigError(
        'CLIENT_SECRET_PREVIOUS_PEPPERS must be a comma separated list of id:pepper pairs',
      );
    }
    peppers.push({
      id: parsePepperId(entry.slice(0, separator), 'CLIENT_SECRET_PREVIOUS_PEPPERS id'),
      value: parsePepperValue(entry.slice(separator + 1), 'CLIENT_SECRET_PREVIOUS_PEPPERS value'),
    });
  }
  return peppers;
}

/**
 * Builds the pepper registry from validated configuration.
 *
 * Production fails closed without `CLIENT_SECRET_PEPPER`: falling back to the development
 * pepper there would silently store secrets under a public constant. Development and test use
 * the development pepper so a local checkout and the benchmark/seed scripts keep working.
 */
export function loadClientSecretPeppers(env: ClientSecretPepperEnv): ClientSecretPeppers {
  const raw = env.CLIENT_SECRET_PEPPER?.trim();
  const id = parsePepperId(env.CLIENT_SECRET_PEPPER_ID ?? 'k1', 'CLIENT_SECRET_PEPPER_ID');
  const previous = parsePreviousPeppers(env.CLIENT_SECRET_PREVIOUS_PEPPERS);

  if (raw === undefined || raw === '') {
    if (env.NODE_ENV === 'production') {
      throw new ClientSecretConfigError(
        'CLIENT_SECRET_PEPPER is required in production to store client secrets as a keyed ' +
          'HMAC; supply it from KMS/Vault',
      );
    }
    return {
      current: {
        id: DEV_CLIENT_SECRET_PEPPER_ID,
        value: Buffer.from(DEV_CLIENT_SECRET_PEPPER, 'utf8'),
      },
      previous: [],
    };
  }

  if (previous.some((pepper) => pepper.id === id)) {
    throw new ClientSecretConfigError(
      'CLIENT_SECRET_PREVIOUS_PEPPERS must not repeat the current CLIENT_SECRET_PEPPER_ID',
    );
  }
  if (new Set(previous.map((pepper) => pepper.id)).size !== previous.length) {
    throw new ClientSecretConfigError('CLIENT_SECRET_PREVIOUS_PEPPERS must not repeat a pepper id');
  }

  return { current: { id, value: parsePepperValue(raw, 'CLIENT_SECRET_PEPPER') }, previous };
}

let defaultCache: { key: string; service: ClientSecretService } | undefined;

/**
 * Service built from the process environment. Call sites that own validated configuration
 * (bootstrap, admin routes, scripts) should pass an explicit service; this default keeps
 * direct `authenticateClient` calls (and tests) working with the same rules.
 */
export function defaultClientSecretService(
  env: ClientSecretPepperEnv = process.env,
): ClientSecretService {
  const key = [
    env.NODE_ENV ?? '',
    env.CLIENT_SECRET_PEPPER ?? '',
    env.CLIENT_SECRET_PEPPER_ID ?? '',
    env.CLIENT_SECRET_PREVIOUS_PEPPERS ?? '',
  ].join('\u0000');
  if (defaultCache?.key === key) {
    return defaultCache.service;
  }
  const service = createClientSecretService(loadClientSecretPeppers(env));
  defaultCache = { key, service };
  return service;
}
