import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 192 bits of entropy, URL-safe so it can be pasted from a log line. */
export function generateSetupToken(): string {
  return randomBytes(24).toString('base64url');
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time comparison of the candidate against the expected setup token. Both sides are
 * hashed first so the comparison length never depends on the candidate.
 */
export function setupTokenMatches(expected: string, candidate: string): boolean {
  return timingSafeEqual(digest(expected), digest(candidate));
}
