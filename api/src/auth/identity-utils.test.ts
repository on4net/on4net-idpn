import { describe, expect, it } from 'vitest';

import { maskEmail, normalizeEmail, normalizeUsername } from './normalize.js';
import {
  createOpaqueToken,
  digestsEqual,
  hashOpaqueToken,
  verifyOpaqueToken,
} from './opaque-token.js';

describe('normalization', () => {
  it('lowercases and trims emails', () => {
    expect(normalizeEmail('  Sara.Mohammadi@Example.COM ')).toBe('sara.mohammadi@example.com');
  });

  it('lowercases and trims usernames', () => {
    expect(normalizeUsername('  SMohammadi  ')).toBe('smohammadi');
  });

  it('masks an email for logs without exposing the local part', () => {
    expect(maskEmail('sara@example.com')).toBe('s***@example.com');
    expect(maskEmail('not-an-email')).toBe('***');
  });
});

describe('opaque tokens', () => {
  it('generates a token and a hash that never contains the token', () => {
    const { token, hash } = createOpaqueToken();

    expect(token.length).toBeGreaterThan(30);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hash).toBe(hashOpaqueToken(token));
  });

  it('generates a different token each time', () => {
    expect(createOpaqueToken().hash).not.toBe(createOpaqueToken().hash);
  });

  it('verifies only the matching token', () => {
    const { token, hash } = createOpaqueToken();

    expect(verifyOpaqueToken(token, hash)).toBe(true);
    expect(verifyOpaqueToken(`${token}x`, hash)).toBe(false);
    expect(verifyOpaqueToken(token, hashOpaqueToken('other'))).toBe(false);
  });

  it('rejects malformed digests instead of throwing', () => {
    expect(digestsEqual('', '')).toBe(false);
    expect(digestsEqual('abc', 'abcd')).toBe(false);
  });
});
