import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for credentials that must be stored but never read back, such as
 * per-client social provider secrets (`docs/security.md` T25, `docs/domain-model.md` 2.6.1).
 *
 * Envelope format (stored as `bytea`):
 *
 * ```
 * [version: 1 byte][iv: 12 bytes][auth tag: 16 bytes][ciphertext: n bytes]
 * ```
 *
 * The version byte is authenticated as additional data, so a future envelope change cannot be
 * downgraded silently. A fresh random IV is generated for every encryption; reusing an IV
 * with AES-GCM would leak plaintext and break the authentication tag.
 *
 * **KMS seam:** this module only needs a 32-byte key. At startup the API reads it from
 * `SOCIAL_SECRET_KEY`, which the deployment should populate from AWS KMS, GCP KMS or Vault
 * (for example `SOCIAL_SECRET_KEY=$(vault kv get -field=key secret/idpn/social)`). Swapping
 * the key source, or implementing {@link SecretBox} with a KMS `Encrypt`/`Decrypt` call,
 * requires no change in the admin routes or repository because they depend on this interface.
 */

/** Environment variable that carries the key-encryption key (base64 of exactly 32 bytes). */
export const SOCIAL_SECRET_KEY_ENV = 'SOCIAL_SECRET_KEY';

/**
 * Optional dedicated key for TOTP secrets (`docs/security.md` 9). Falling back to
 * `SOCIAL_SECRET_KEY` keeps single-key deployments working, but production should supply a
 * separate key so the two ciphertext families are not interchangeable.
 */
export const MFA_SECRET_KEY_ENV = 'MFA_SECRET_KEY';

/** AES-256 requires a 256-bit key. */
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION_BYTES = 1;
const ENVELOPE_VERSION = 1;
const HEADER_BYTES = VERSION_BYTES + IV_BYTES + TAG_BYTES;
const BASE64_KEY = /^[A-Za-z0-9+/]+={0,2}$/;

/** Raised for invalid keys and envelopes. Messages never include key or secret material. */
export class SecretBoxError extends Error {
  override readonly name = 'SecretBoxError';
}

export interface SecretBox {
  /** Returns a versioned AES-256-GCM envelope; the IV is unique per call. */
  encrypt(plaintext: string): Buffer;
  /** Verifies and decrypts an envelope. Throws {@link SecretBoxError} on any tampering. */
  decrypt(envelope: Uint8Array): string;
}

/**
 * Parses the base64 key from configuration and rejects anything that is not exactly
 * 32 bytes in canonical base64 form, so a truncated or mistyped key fails at startup.
 */
export function parseSecretKey(value: string): Buffer {
  const normalized = value.trim();
  if (!BASE64_KEY.test(normalized)) {
    throw new SecretBoxError(`${SOCIAL_SECRET_KEY_ENV} must be base64 of exactly 32 bytes`);
  }
  const key = Buffer.from(normalized, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== normalized) {
    throw new SecretBoxError(`${SOCIAL_SECRET_KEY_ENV} must be base64 of exactly 32 bytes`);
  }
  return key;
}

/** Builds the encryptor used for social provider secrets. */
export function createSecretBox(key: Buffer | string): SecretBox {
  const keyBytes = typeof key === 'string' ? parseSecretKey(key) : Buffer.from(key);
  if (keyBytes.length !== KEY_BYTES) {
    throw new SecretBoxError(`${SOCIAL_SECRET_KEY_ENV} must decode to exactly 32 bytes`);
  }

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', keyBytes, iv);
      cipher.setAAD(Buffer.from([ENVELOPE_VERSION]));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
    },

    decrypt(envelope) {
      const data = Buffer.from(envelope);
      if (data.length < HEADER_BYTES) {
        throw new SecretBoxError('secret envelope is malformed');
      }
      if (data[0] !== ENVELOPE_VERSION) {
        throw new SecretBoxError('secret envelope version is not supported');
      }
      const iv = data.subarray(VERSION_BYTES, VERSION_BYTES + IV_BYTES);
      const tag = data.subarray(VERSION_BYTES + IV_BYTES, VERSION_BYTES + IV_BYTES + TAG_BYTES);
      const ciphertext = data.subarray(HEADER_BYTES);
      try {
        const decipher = createDecipheriv('aes-256-gcm', keyBytes, iv);
        decipher.setAAD(Buffer.from([ENVELOPE_VERSION]));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        // Wrong key, modified IV/tag/ciphertext and truncation all reach this branch.
        throw new SecretBoxError('secret envelope could not be decrypted');
      }
    },
  };
}

export interface SecretKeyEnv {
  NODE_ENV?: string | undefined;
  SOCIAL_SECRET_KEY?: string | undefined;
}

/**
 * Loads the key during bootstrap. Production fails closed: without a valid key the process
 * refuses to start instead of storing provider secrets in plaintext or dropping them.
 * Development and test may run without a key; the social-provider write endpoint then
 * answers `503` instead of persisting an unencrypted credential.
 */
export function loadSocialSecretKey(env: SecretKeyEnv): Buffer | null {
  const raw = env.SOCIAL_SECRET_KEY?.trim();
  if (raw === undefined || raw === '') {
    if (env.NODE_ENV === 'production') {
      throw new SecretBoxError(
        `${SOCIAL_SECRET_KEY_ENV} is required in production to encrypt social provider secrets`,
      );
    }
    return null;
  }
  return parseSecretKey(raw);
}

export interface MfaSecretKeyEnv {
  NODE_ENV?: string | undefined;
  MFA_SECRET_KEY?: string | undefined;
  SOCIAL_SECRET_KEY?: string | undefined;
}

/**
 * Loads the key used for TOTP secrets. `MFA_SECRET_KEY` wins; `SOCIAL_SECRET_KEY` is the
 * documented fallback for deployments with a single key. Returns `null` in development/test
 * when neither is set, in which case TOTP enrollment answers `503` instead of storing a
 * secret in plaintext.
 */
export function loadMfaSecretKey(env: MfaSecretKeyEnv): Buffer | null {
  const raw = env.MFA_SECRET_KEY?.trim();
  if (raw !== undefined && raw !== '') {
    return parseSecretKey(raw);
  }
  const fallback = env.SOCIAL_SECRET_KEY?.trim();
  if (fallback !== undefined && fallback !== '') {
    return parseSecretKey(fallback);
  }
  if (env.NODE_ENV === 'production') {
    throw new SecretBoxError(
      `${MFA_SECRET_KEY_ENV} (or ${SOCIAL_SECRET_KEY_ENV}) is required in production to encrypt TOTP secrets`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Key ring (card #78 section 3): envelope version 2 names the key that wrote it.
//
// Layout: [version=2: 1 byte][key id: 1 byte][iv: 12][auth tag: 16][ciphertext]. Both header
// bytes are authenticated as additional data. Envelopes written before the ring (version 1)
// carry no key id and are tried against every configured key, so the first deployment of the
// ring needs no data migration; `needsRewrap` reports what `ops:rewrap-secrets` should move to
// the current key before a superseded key is removed from the configuration.
// ---------------------------------------------------------------------------------------------

const KEYRING_VERSION = 2;
const KEYRING_HEADER_BYTES = 1 + 1 + IV_BYTES + TAG_BYTES;

export interface SecretKeyEntry {
  /** 1-255; stored in every v2 envelope. */
  id: number;
  key: Buffer;
}

export interface SecretKeyring {
  current: SecretKeyEntry;
  /** Superseded keys, used to decrypt only. */
  previous: SecretKeyEntry[];
}

export interface KeyringSecretBox extends SecretBox {
  /** True for a v1 envelope or one written under a key other than the current one. */
  needsRewrap(envelope: Uint8Array): boolean;
}

function assertKeyEntry(entry: SecretKeyEntry, label: string): void {
  if (!Number.isInteger(entry.id) || entry.id < 1 || entry.id > 255) {
    throw new SecretBoxError(`${label} key id must be an integer between 1 and 255`);
  }
  if (entry.key.length !== KEY_BYTES) {
    throw new SecretBoxError(`${label} key must decode to exactly 32 bytes`);
  }
}

function decryptWith(key: Buffer, aad: Buffer, iv: Buffer, tag: Buffer, data: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Builds a box that writes v2 envelopes under `current` and reads v1/v2 with the whole ring. */
export function createKeyringSecretBox(ring: SecretKeyring): KeyringSecretBox {
  assertKeyEntry(ring.current, 'current');
  for (const entry of ring.previous) {
    assertKeyEntry(entry, 'previous');
  }
  const ids = [ring.current.id, ...ring.previous.map((entry) => entry.id)];
  if (new Set(ids).size !== ids.length) {
    throw new SecretBoxError('secret key ids must be unique');
  }
  const all = [ring.current, ...ring.previous];

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const header = Buffer.from([KEYRING_VERSION, ring.current.id]);
      const cipher = createCipheriv('aes-256-gcm', ring.current.key, iv);
      cipher.setAAD(header);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
    },

    decrypt(envelope) {
      const data = Buffer.from(envelope);
      if (data[0] === KEYRING_VERSION) {
        if (data.length < KEYRING_HEADER_BYTES) {
          throw new SecretBoxError('secret envelope is malformed');
        }
        const entry = all.find((candidate) => candidate.id === data[1]);
        if (entry === undefined) {
          throw new SecretBoxError('secret envelope names a key that is not configured');
        }
        const iv = data.subarray(2, 2 + IV_BYTES);
        const tag = data.subarray(2 + IV_BYTES, 2 + IV_BYTES + TAG_BYTES);
        try {
          return decryptWith(
            entry.key,
            data.subarray(0, 2),
            iv,
            tag,
            data.subarray(KEYRING_HEADER_BYTES),
          );
        } catch {
          throw new SecretBoxError('secret envelope could not be decrypted');
        }
      }
      if (data[0] !== ENVELOPE_VERSION) {
        throw new SecretBoxError('secret envelope version is not supported');
      }
      if (data.length < HEADER_BYTES) {
        throw new SecretBoxError('secret envelope is malformed');
      }
      const iv = data.subarray(VERSION_BYTES, VERSION_BYTES + IV_BYTES);
      const tag = data.subarray(VERSION_BYTES + IV_BYTES, HEADER_BYTES);
      for (const entry of all) {
        try {
          return decryptWith(
            entry.key,
            Buffer.from([ENVELOPE_VERSION]),
            iv,
            tag,
            data.subarray(HEADER_BYTES),
          );
        } catch {
          // Try the next key: a v1 envelope does not say which one wrote it.
        }
      }
      throw new SecretBoxError('secret envelope could not be decrypted');
    },

    needsRewrap(envelope) {
      return envelope[0] !== KEYRING_VERSION || envelope[1] !== ring.current.id;
    },
  };
}

export interface SigningKeyWrapEnv {
  SIGNING_KEY_WRAP_KEY?: string | undefined;
  SIGNING_KEY_WRAP_KEY_ID?: string | number | undefined;
  SIGNING_KEY_WRAP_PREVIOUS_KEYS?: string | undefined;
}

/**
 * Key ring that wraps signing-key private material in the `db://` store. `null` when
 * `SIGNING_KEY_WRAP_KEY` is not set; the caller decides whether that is acceptable.
 */
export function loadSigningKeyWrapKeyring(env: SigningKeyWrapEnv): SecretKeyring | null {
  const raw = env.SIGNING_KEY_WRAP_KEY?.trim();
  if (raw === undefined || raw === '') {
    return null;
  }
  return {
    current: {
      id: parseKeyId(env.SIGNING_KEY_WRAP_KEY_ID, 'SIGNING_KEY_WRAP_KEY_ID'),
      key: parseSecretKey(raw),
    },
    previous: parsePreviousKeys(
      env.SIGNING_KEY_WRAP_PREVIOUS_KEYS,
      'SIGNING_KEY_WRAP_PREVIOUS_KEYS',
    ),
  };
}

export interface SecretKeyringEnv {
  NODE_ENV?: string | undefined;
  SOCIAL_SECRET_KEY?: string | undefined;
  SOCIAL_SECRET_KEY_ID?: string | number | undefined;
  SOCIAL_SECRET_PREVIOUS_KEYS?: string | undefined;
  MFA_SECRET_KEY?: string | undefined;
  MFA_SECRET_KEY_ID?: string | number | undefined;
  MFA_SECRET_PREVIOUS_KEYS?: string | undefined;
}

function parseKeyId(value: string | number | undefined, label: string): number {
  if (value === undefined || String(value).trim() === '') {
    return 1;
  }
  const id = Number(String(value).trim());
  if (!Number.isInteger(id) || id < 1 || id > 255) {
    throw new SecretBoxError(`${label} must be an integer between 1 and 255`);
  }
  return id;
}

function parsePreviousKeys(value: string | undefined, label: string): SecretKeyEntry[] {
  const raw = value?.trim();
  if (raw === undefined || raw === '') {
    return [];
  }
  return raw.split(',').map((pair) => {
    const separator = pair.indexOf(':');
    if (separator === -1) {
      throw new SecretBoxError(`${label} must be a comma separated list of id:base64key pairs`);
    }
    return {
      id: parseKeyId(pair.slice(0, separator), `${label} id`),
      key: parseSecretKey(pair.slice(separator + 1)),
    };
  });
}

/** Key ring for social provider secrets; `null` only outside production without a key. */
export function loadSocialSecretKeyring(env: SecretKeyringEnv): SecretKeyring | null {
  const key = loadSocialSecretKey(env);
  if (key === null) {
    return null;
  }
  return {
    current: { id: parseKeyId(env.SOCIAL_SECRET_KEY_ID, 'SOCIAL_SECRET_KEY_ID'), key },
    previous: parsePreviousKeys(env.SOCIAL_SECRET_PREVIOUS_KEYS, 'SOCIAL_SECRET_PREVIOUS_KEYS'),
  };
}

/**
 * Key ring for TOTP secrets. A dedicated `MFA_SECRET_KEY` has its own id and previous keys;
 * without one the social ring is reused (single-key deployments).
 */
export function loadMfaSecretKeyring(env: SecretKeyringEnv): SecretKeyring | null {
  const dedicated = env.MFA_SECRET_KEY?.trim();
  if (dedicated !== undefined && dedicated !== '') {
    return {
      current: {
        id: parseKeyId(env.MFA_SECRET_KEY_ID, 'MFA_SECRET_KEY_ID'),
        key: parseSecretKey(dedicated),
      },
      previous: parsePreviousKeys(env.MFA_SECRET_PREVIOUS_KEYS, 'MFA_SECRET_PREVIOUS_KEYS'),
    };
  }
  const key = loadMfaSecretKey(env);
  return key === null ? null : loadSocialSecretKeyring({ ...env, NODE_ENV: env.NODE_ENV });
}
