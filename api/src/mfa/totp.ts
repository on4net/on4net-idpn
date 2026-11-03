import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP on top of RFC 4226 HOTP, implemented with `node:crypto` only.
 *
 * Fixed profile (docs/security.md 3.3, docs/auth-flows.md 7):
 * SHA-1, 30-second step, 6 digits, one-step clock skew. Nothing here logs or returns a
 * secret; callers decrypt the stored envelope and pass the base32 secret in memory.
 */

export const TOTP_ALGORITHM = 'SHA1';
export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/** ±1 step tolerance for clock skew (docs/security.md 3.3). */
export const TOTP_WINDOW = 1;
/** 160-bit secret, the size Google Authenticator and RFC 4226 recommend. */
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_PATTERN = /^\d{6}$/;

/** Encodes bytes as RFC 4648 base32 without padding, as authenticator apps expect. */
export function encodeBase32(bytes: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let output = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Decodes base32. Accepts lowercase, spaces and optional `=` padding so a user can paste a
 * secret from any authenticator; rejects anything outside the alphabet (no silent loss).
 */
export function decodeBase32(input: string): Buffer {
  const normalized = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (normalized === '') {
    throw new Error('base32 secret is empty');
  }
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error('base32 secret contains an invalid character');
    }
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  if (![0, 2, 4, 5, 7].includes(bits)) {
    // A leftover of 1, 3 or 6 bits cannot come from a whole number of bytes.
    throw new Error('base32 secret has an invalid length');
  }
  return Buffer.from(bytes);
}

/** Generates a fresh base32 secret (20 random bytes). */
export function generateTotpSecret(bytes: Uint8Array = randomBytes(TOTP_SECRET_BYTES)): string {
  return encodeBase32(bytes);
}

/** 8-byte big-endian HOTP counter. */
function counterBuffer(counter: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);
  return buffer;
}

/** RFC 4226 HOTP value for one counter. */
export function hotp(secret: Buffer, counter: bigint, digits: number = TOTP_DIGITS): string {
  const digest = createHmac('sha1', secret).update(counterBuffer(counter)).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    ((digest[offset] ?? 0) & 0x7f) * 2 ** 24 +
    ((digest[offset + 1] ?? 0) & 0xff) * 2 ** 16 +
    ((digest[offset + 2] ?? 0) & 0xff) * 2 ** 8 +
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** TOTP time step for an instant (Unix seconds / 30). */
export function stepAt(atMs: number, stepSeconds: number = TOTP_STEP_SECONDS): bigint {
  return BigInt(Math.floor(atMs / 1000 / stepSeconds));
}

/** Current code for a base32 secret at an instant. */
export function totpCode(
  secret: string,
  atMs: number,
  digits: number = TOTP_DIGITS,
  stepSeconds: number = TOTP_STEP_SECONDS,
): string {
  return hotp(decodeBase32(secret), stepAt(atMs, stepSeconds), digits);
}

export type TotpFailure = 'invalid_format' | 'mismatch' | 'replayed';

export type TotpVerification = { ok: true; step: bigint } | { ok: false; reason: TotpFailure };

export interface VerifyTotpOptions {
  /** Server time in milliseconds; injectable for tests. */
  atMs: number;
  window?: number;
  /** Highest accepted step; anything at or below it was already used (anti-replay). */
  lastUsedStep?: bigint | null;
  digits?: number;
  stepSeconds?: number;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifies a TOTP code inside the ±window. A step at or below `lastUsedStep` is rejected as
 * replayed, so a captured code cannot be used twice even inside its validity window.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: VerifyTotpOptions,
): TotpVerification {
  const digits = options.digits ?? TOTP_DIGITS;
  const stepSeconds = options.stepSeconds ?? TOTP_STEP_SECONDS;
  const window = options.window ?? TOTP_WINDOW;
  const candidate = code.replace(/\s/g, '');
  const format = digits === TOTP_DIGITS ? CODE_PATTERN : new RegExp(`^\\d{${digits}}$`);
  if (!format.test(candidate)) {
    return { ok: false, reason: 'invalid_format' };
  }

  const secretBytes = decodeBase32(secret);
  const current = stepAt(options.atMs, stepSeconds);
  let replayed = false;

  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + BigInt(offset);
    if (step < 0n) {
      continue;
    }
    const expected = hotp(secretBytes, step, digits);
    if (!constantTimeEquals(expected, candidate)) {
      continue;
    }
    if (options.lastUsedStep !== undefined && options.lastUsedStep !== null) {
      if (step <= options.lastUsedStep) {
        replayed = true;
        continue;
      }
    }
    return { ok: true, step };
  }

  return { ok: false, reason: replayed ? 'replayed' : 'mismatch' };
}

export interface OtpauthUriInput {
  /** Service name shown as the issuer in authenticator apps. */
  issuer: string;
  /** Account label, typically the username or email. */
  accountName: string;
  secret: string;
  digits?: number;
  stepSeconds?: number;
}

/** `otpauth://` provisioning URI for QR rendering (docs/auth-flows.md 7.2). */
export function buildOtpauthUri(input: OtpauthUriInput): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountName)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: TOTP_ALGORITHM,
    digits: String(input.digits ?? TOTP_DIGITS),
    period: String(input.stepSeconds ?? TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
