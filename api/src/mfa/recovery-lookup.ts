import { createHmac } from 'node:crypto';

/**
 * Server-keyed lookup value for recovery codes (card #79, docs/auth-flows.md 7.5).
 *
 * A recovery code is hashed with Argon2id so a stolen database cannot be ground offline, but
 * Argon2id also made every attempt cost one verification per unused code. The lookup column
 * next to the hash is `HMAC-SHA-256(key, "idpn.recovery-lookup.v1\0" || normalizedCode)`: the
 * server can find the one candidate row in O(1) and run exactly one Argon2id verification,
 * while a database dump alone reveals nothing usable (the key lives outside PostgreSQL, like
 * `PASSWORD_PEPPER`). The lookup never replaces the hash check: it only selects the row.
 *
 * Stored as `<keyId>$<digest>` so the key can be rotated: new rows use the current key and rows
 * written under a previous key are still found (every configured key is tried). A stored
 * lookup cannot be re-keyed without the plaintext, so a previous key stays configured until
 * the codes written under it have been used or regenerated (docs/auth-flows.md 7.5).
 */

export interface RecoveryLookupKey {
  /** Short public identifier stored with every lookup value. */
  id: string;
  value: Buffer;
}

export interface RecoveryLookupKeys {
  current: RecoveryLookupKey;
  /** Superseded keys, used to find rows only; never to write. */
  previous: RecoveryLookupKey[];
}

export interface RecoveryLookup {
  /** Lookup value written for a new row. */
  create(normalizedCode: string): string;
  /** Every value the row could be stored under (current key first, then previous keys). */
  candidates(normalizedCode: string): string[];
}

export class RecoveryLookupConfigError extends Error {
  override readonly name = 'RecoveryLookupConfigError';
}

const DOMAIN = 'idpn.recovery-lookup.v1' + String.fromCharCode(0);
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
const MIN_KEY_LENGTH = 32;

/** Development/test key. Not a secret; production refuses to start without a real one. */
export const DEV_RECOVERY_LOOKUP_KEY = 'idpn-development-recovery-lookup-key-not-for-production';
export const DEV_RECOVERY_LOOKUP_KEY_ID = 'dev';

const lookupFor = (code: string, key: RecoveryLookupKey): string =>
  `${key.id}$${createHmac('sha256', key.value)
    .update(DOMAIN + code, 'utf8')
    .digest('base64url')}`;

export function createRecoveryLookup(keys: RecoveryLookupKeys): RecoveryLookup {
  return {
    create: (code) => lookupFor(code, keys.current),
    candidates: (code) => [keys.current, ...keys.previous].map((key) => lookupFor(code, key)),
  };
}

export interface RecoveryLookupEnv {
  NODE_ENV?: string | undefined;
  RECOVERY_LOOKUP_KEY?: string | undefined;
  RECOVERY_LOOKUP_KEY_ID?: string | undefined;
  /** Comma separated `id:key` pairs of superseded keys. */
  RECOVERY_LOOKUP_PREVIOUS_KEYS?: string | undefined;
}

function parseKey(id: string, value: string, label: string): RecoveryLookupKey {
  const trimmedId = id.trim();
  if (!KEY_ID_PATTERN.test(trimmedId)) {
    throw new RecoveryLookupConfigError(
      `${label} id must be 1-16 characters of letters, digits, dash or underscore`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length < MIN_KEY_LENGTH) {
    throw new RecoveryLookupConfigError(
      `${label} must be at least ${String(MIN_KEY_LENGTH)} characters`,
    );
  }
  return { id: trimmedId, value: Buffer.from(trimmed, 'utf8') };
}

/** Builds the key set from configuration; production fails closed without a key. */
export function loadRecoveryLookupKeys(env: RecoveryLookupEnv): RecoveryLookupKeys {
  const raw = env.RECOVERY_LOOKUP_KEY?.trim();
  const previous: RecoveryLookupKey[] = [];
  const previousRaw = env.RECOVERY_LOOKUP_PREVIOUS_KEYS?.trim();
  if (previousRaw !== undefined && previousRaw !== '') {
    for (const entry of previousRaw.split(',')) {
      const separator = entry.indexOf(':');
      if (separator === -1) {
        throw new RecoveryLookupConfigError(
          'RECOVERY_LOOKUP_PREVIOUS_KEYS must be a comma separated list of id:key pairs',
        );
      }
      previous.push(
        parseKey(
          entry.slice(0, separator),
          entry.slice(separator + 1),
          'RECOVERY_LOOKUP_PREVIOUS_KEYS key',
        ),
      );
    }
  }

  if (raw === undefined || raw === '') {
    if (env.NODE_ENV === 'production') {
      throw new RecoveryLookupConfigError(
        'RECOVERY_LOOKUP_KEY is required in production (supply it from KMS/Vault)',
      );
    }
    return {
      current: {
        id: DEV_RECOVERY_LOOKUP_KEY_ID,
        value: Buffer.from(DEV_RECOVERY_LOOKUP_KEY, 'utf8'),
      },
      previous: [],
    };
  }

  const current = parseKey(env.RECOVERY_LOOKUP_KEY_ID ?? 'k1', raw, 'RECOVERY_LOOKUP_KEY');
  const ids = [current.id, ...previous.map((key) => key.id)];
  if (new Set(ids).size !== ids.length) {
    throw new RecoveryLookupConfigError(
      'RECOVERY_LOOKUP_KEY_ID and RECOVERY_LOOKUP_PREVIOUS_KEYS must not repeat a key id',
    );
  }
  return { current, previous };
}
