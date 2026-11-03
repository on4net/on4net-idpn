import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface OpaqueToken {
  /** Value sent to the user (email link / cookie); never stored. */
  token: string;
  /** SHA-256 hex digest persisted in the database. */
  hash: string;
}

/** Generates a 32-byte URL-safe token and its storage hash for reset/verify flows. */
export function createOpaqueToken(bytes = 32): OpaqueToken {
  const token = randomBytes(bytes).toString('base64url');
  return { token, hash: hashOpaqueToken(token) };
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function digestsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Verifies a presented token against the stored hash without leaking timing. */
export function verifyOpaqueToken(token: string, storedHash: string): boolean {
  return digestsEqual(hashOpaqueToken(token), storedHash);
}
