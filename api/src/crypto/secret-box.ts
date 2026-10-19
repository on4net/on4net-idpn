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
