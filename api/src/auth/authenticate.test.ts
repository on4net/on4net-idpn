import argon2 from 'argon2';
import { describe, expect, it, vi } from 'vitest';

import { authenticateWithPassword, isLocked, type AuthenticatableUser } from './authenticate.js';
import { hashPassword, type Argon2Params } from './password.js';

const FAST: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const password = 'a-very-long-password';

let cachedHash: string | undefined;

const hash = async (): Promise<string> => {
  cachedHash ??= await hashPassword(password, FAST);
  return cachedHash;
};

const baseUser = async (
  overrides: Partial<AuthenticatableUser> = {},
): Promise<AuthenticatableUser> => ({
  id: 'user-1',
  status: 'active',
  passwordHash: await hash(),
  lockedUntil: null,
  deletedAt: null,
  ...overrides,
});

describe('authenticateWithPassword', () => {
  it('accepts an active user with the right password', async () => {
    const result = await authenticateWithPassword(await baseUser(), password, { params: FAST });

    expect(result).toEqual({ ok: true, userId: 'user-1' });
  });

  it('rejects a wrong password without revealing the user', async () => {
    const result = await authenticateWithPassword(await baseUser(), 'wrong-password-x', {
      params: FAST,
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('rejects disabled users even with the correct password', async () => {
    const result = await authenticateWithPassword(
      await baseUser({ status: 'disabled' }),
      password,
      { params: FAST },
    );

    expect(result).toEqual({ ok: false, reason: 'user_disabled' });
  });

  it('rejects locked users until the lock expires', async () => {
    const lockedUntil = new Date('2026-10-18T12:00:00Z');
    const locked = await baseUser({ status: 'locked', lockedUntil });

    await expect(
      authenticateWithPassword(locked, password, {
        params: FAST,
        now: () => new Date('2026-10-18T11:59:00Z'),
      }),
    ).resolves.toEqual({ ok: false, reason: 'user_locked' });

    await expect(
      authenticateWithPassword(locked, password, {
        params: FAST,
        now: () => new Date('2026-10-18T12:01:00Z'),
      }),
    ).resolves.toEqual({ ok: true, userId: 'user-1' });
  });

  it('rejects soft-deleted users', async () => {
    const result = await authenticateWithPassword(
      await baseUser({ deletedAt: new Date('2026-01-01T00:00:00Z') }),
      password,
      { params: FAST },
    );

    expect(result).toEqual({ ok: false, reason: 'user_deleted' });
  });

  it('rejects users without a password (social/OTP only)', async () => {
    const result = await authenticateWithPassword(
      await baseUser({ passwordHash: null }),
      password,
      {
        params: FAST,
      },
    );

    expect(result).toEqual({ ok: false, reason: 'no_password' });
  });

  it('short-circuits a locked account without hashing; the login route pays the cost', async () => {
    const locked = await baseUser({
      status: 'locked',
      lockedUntil: new Date('2030-01-01T00:00:00Z'),
    });
    const verify = vi.spyOn(argon2, 'verify');
    try {
      await authenticateWithPassword(locked, password, { params: FAST });
      // Deliberate: the decoy verification lives in the route (`login-route.test.ts` asserts
      // exactly one Argon2 verification on every rejection branch), not in this helper.
      expect(verify).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
    }
  });
});

describe('isLocked', () => {
  it('treats a locked user without an expiry as locked', () => {
    expect(
      isLocked({
        id: 'u',
        status: 'locked',
        passwordHash: null,
        lockedUntil: null,
        deletedAt: null,
      }),
    ).toBe(true);
  });

  it('is false for active users', () => {
    expect(
      isLocked({
        id: 'u',
        status: 'active',
        passwordHash: null,
        lockedUntil: null,
        deletedAt: null,
      }),
    ).toBe(false);
  });
});
