import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password.js';
import { argon2ParamsFromEnv } from './password-config.js';

const env = {
  ARGON2_MEMORY_KIB: 8_192,
  ARGON2_TIME_COST: 1,
  ARGON2_PARALLELISM: 1,
};

describe('argon2ParamsFromEnv', () => {
  it('maps the validated environment onto the hashing policy', () => {
    expect(argon2ParamsFromEnv(env)).toEqual({
      memoryCost: 8_192,
      timeCost: 1,
      parallelism: 1,
    });
  });

  it('keeps the configured pepper out of the returned policy unless it is set', () => {
    expect(argon2ParamsFromEnv({ ...env, PASSWORD_PEPPER: '' })).not.toHaveProperty('pepper');
    expect(argon2ParamsFromEnv({ ...env, PASSWORD_PEPPER: 'p'.repeat(32) })).toMatchObject({
      pepper: 'p'.repeat(32),
    });
  });

  it('produces hashes that cannot be verified without the same pepper', async () => {
    const peppered = argon2ParamsFromEnv({ ...env, PASSWORD_PEPPER: 'p'.repeat(32) });
    const unpeppered = argon2ParamsFromEnv(env);
    const hash = await hashPassword('correct horse battery staple', peppered);

    await expect(
      verifyPassword(hash, 'correct horse battery staple', peppered),
    ).resolves.toBe(true);
    await expect(
      verifyPassword(hash, 'correct horse battery staple', unpeppered),
    ).resolves.toBe(false);
  });
});
