import { describe, expect, it } from 'vitest';

import { hashPassword, needsPepperUpgrade, verifyPassword } from './password.js';
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

    await expect(verifyPassword(hash, 'correct horse battery staple', peppered)).resolves.toBe(
      true,
    );
    await expect(verifyPassword(hash, 'correct horse battery staple', unpeppered)).resolves.toBe(
      false,
    );
  });
});

describe('pepper rotation window (#70)', () => {
  const password = 'correct horse battery staple';
  const oldPepper = 'o'.repeat(32);
  const newPepper = 'n'.repeat(32);

  it('accepts a hash made under the previous pepper and flags it for rewrite', async () => {
    const before = argon2ParamsFromEnv({ ...env, PASSWORD_PEPPER: oldPepper });
    const during = argon2ParamsFromEnv({
      ...env,
      PASSWORD_PEPPER: newPepper,
      PASSWORD_PEPPER_PREVIOUS: [oldPepper],
    });
    const hash = await hashPassword(password, before);

    await expect(verifyPassword(hash, password, during)).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong password', during)).resolves.toBe(false);
    await expect(needsPepperUpgrade(hash, password, during)).resolves.toBe(true);

    const upgraded = await hashPassword(password, during);
    await expect(needsPepperUpgrade(upgraded, password, during)).resolves.toBe(false);
    // Once the window is closed only the new pepper works.
    const after = argon2ParamsFromEnv({ ...env, PASSWORD_PEPPER: newPepper });
    await expect(verifyPassword(upgraded, password, after)).resolves.toBe(true);
    await expect(verifyPassword(hash, password, after)).resolves.toBe(false);
  });

  it('accepts unpeppered legacy hashes only when explicitly allowed', async () => {
    const hash = await hashPassword(password, argon2ParamsFromEnv(env));
    const strict = argon2ParamsFromEnv({ ...env, PASSWORD_PEPPER: newPepper });
    const lenient = argon2ParamsFromEnv({
      ...env,
      PASSWORD_PEPPER: newPepper,
      PASSWORD_ACCEPT_UNPEPPERED: true,
    });
    await expect(verifyPassword(hash, password, strict)).resolves.toBe(false);
    await expect(verifyPassword(hash, password, lenient)).resolves.toBe(true);
    await expect(needsPepperUpgrade(hash, password, lenient)).resolves.toBe(true);
  });

  it('costs nothing extra when no rotation window is configured', async () => {
    const params = argon2ParamsFromEnv({ ...env, PASSWORD_PEPPER: newPepper });
    const hash = await hashPassword(password, params);
    await expect(needsPepperUpgrade(hash, password, params)).resolves.toBe(false);
  });
});
