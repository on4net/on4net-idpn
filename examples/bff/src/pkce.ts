import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** RFC 7636 `S256` challenge of an ASCII code verifier. */
export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Creates a 256-bit code verifier and its `S256` challenge. */
export function createPkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: s256Challenge(verifier), method: 'S256' };
}

/** URL-safe random token, 256 bits by default (used for `state` and `nonce`). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
