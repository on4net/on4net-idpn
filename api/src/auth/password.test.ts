import { describe, expect, it } from 'vitest';

import { hashPassword, needsRehash, verifyPassword, type Argon2Params } from './password.js';

// Cheap parameters keep the unit suite fast; production uses DEFAULT_ARGON2_PARAMS.
const FAST: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };

describe('hashPassword', () => {
  it('produces an Argon2id PHC string', async () => {
    const hash = await hashPassword('correct horse battery', FAST);

    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(hash).toMatch(/\$m=8192,p=1,t=1\$/);
    expect(hash).not.toContain('correct horse battery');
  });

  it('uses a unique salt per call', async () => {
    const first = await hashPassword('same-password-123', FAST);
    const second = await hashPassword('same-password-123', FAST);

    expect(first).not.toBe(second);
  });

  it('honours the configured parameters', async () => {
    const hash = await hashPassword('configured-params', {
      memoryCost: 16_384,
      timeCost: 2,
      parallelism: 2,
    });

    expect(hash).toContain('m=16384');
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=2');
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password and rejects everything else', async () => {
    const hash = await hashPassword('right-password-1', FAST);

    await expect(verifyPassword(hash, 'right-password-1', FAST)).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong-password-1', FAST)).resolves.toBe(false);
    await expect(verifyPassword(hash, '', FAST)).resolves.toBe(false);
  });

  it('fails closed on a malformed hash', async () => {
    await expect(verifyPassword('not-a-phc-string', 'whatever', FAST)).resolves.toBe(false);
  });

  it('binds the hash to the configured pepper', async () => {
    const withPepper = await hashPassword('peppered-password', {
      ...FAST,
      pepper: 'a'.repeat(32),
    });

    await expect(
      verifyPassword(withPepper, 'peppered-password', { ...FAST, pepper: 'a'.repeat(32) }),
    ).resolves.toBe(true);
    await expect(
      verifyPassword(withPepper, 'peppered-password', { ...FAST, pepper: 'b'.repeat(32) }),
    ).resolves.toBe(false);
    await expect(verifyPassword(withPepper, 'peppered-password', FAST)).resolves.toBe(false);
  });
});

describe('needsRehash', () => {
  it('detects a hash created with weaker parameters', async () => {
    const weak = await hashPassword('weak-parameter-hash', {
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1,
    });

    expect(needsRehash(weak, { memoryCost: 65_536, timeCost: 3, parallelism: 1 })).toBe(true);
    expect(needsRehash(weak, { memoryCost: 8192, timeCost: 1, parallelism: 1 })).toBe(false);
    expect(needsRehash('broken', FAST)).toBe(true);
  });
});
