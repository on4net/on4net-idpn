import { describe, expect, it } from 'vitest';

import { sanitizeAuditMetadata } from '../audit/sanitize.js';
import { hashPassword, type Argon2Params } from '../auth/password.js';
import { changePassword, type PasswordChangeUser, type PasswordStore } from './change-password.js';

const FAST: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const now = () => new Date('2026-10-18T10:00:00Z');

interface FakeStore extends PasswordStore {
  user: PasswordChangeUser;
  audits: Parameters<PasswordStore['recordAudit']>[0][];
  updatedHash?: string;
  changedAt?: Date;
}

function createStore(user: PasswordChangeUser): FakeStore {
  const store: FakeStore = {
    user,
    audits: [],
    async findUser() {
      return store.user;
    },
    async updatePassword(_id, hash, changedAt) {
      store.updatedHash = hash;
      store.changedAt = changedAt;
      store.user = { ...store.user, passwordHash: hash };
    },
    async revokeSessions() {
      return 2;
    },
    async revokeRefreshTokens() {
      return 3;
    },
    async recordAudit(event) {
      store.audits.push(event);
    },
  };
  return store;
}

const activeUser = (overrides: Partial<PasswordChangeUser> = {}): PasswordChangeUser => ({
  id: 'user-1',
  email: 'sara@example.com',
  username: 'sara',
  displayName: 'Sara',
  passwordHash: null,
  status: 'active',
  deletedAt: null,
  ...overrides,
});

describe('changePassword', () => {
  it('hashes the new password, revokes everything and audits without secrets', async () => {
    const existing = await hashPassword('old-password-123', FAST);
    const store = createStore(activeUser({ passwordHash: existing }));

    const result = await changePassword(
      store,
      hashPassword,
      {
        userId: 'user-1',
        currentPassword: 'old-password-123',
        newPassword: 'brand-new-password-456',
        ip: '10.0.0.1',
        userAgent: 'vitest',
      },
      now,
    );

    expect(result).toEqual({ ok: true, revokedSessions: 2, revokedRefreshTokens: 3 });
    expect(store.updatedHash).toBeDefined();
    expect(store.updatedHash).not.toContain('brand-new-password-456');
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      action: 'user.password.changed',
      result: 'success',
      targetId: 'user-1',
      ip: '10.0.0.1',
    });
    expect(JSON.stringify(store.audits)).not.toContain('brand-new-password-456');
    expect(JSON.stringify(store.audits)).not.toContain('old-password-123');
  });

  it('rejects a wrong current password and records the failure', async () => {
    const existing = await hashPassword('old-password-123', FAST);
    const store = createStore(activeUser({ passwordHash: existing }));

    const result = await changePassword(
      store,
      hashPassword,
      { userId: 'user-1', currentPassword: 'nope', newPassword: 'brand-new-password-456' },
      now,
    );

    expect(result).toEqual({ ok: false, reason: 'invalid_current_password' });
    expect(store.updatedHash).toBeUndefined();
    expect(store.audits[0]).toMatchObject({
      action: 'user.password.change_failed',
      result: 'failure',
    });
  });

  it('enforces the password policy', async () => {
    const store = createStore(activeUser());
    const result = await changePassword(store, hashPassword, {
      userId: 'user-1',
      newPassword: 'short',
    });

    expect(result).toEqual({ ok: false, reason: 'password_policy', violations: ['too_short'] });
    expect(store.updatedHash).toBeUndefined();
  });

  it('rejects reusing the current password', async () => {
    const existing = await hashPassword('same-password-123', FAST);
    const store = createStore(activeUser({ passwordHash: existing }));

    const result = await changePassword(store, hashPassword, {
      userId: 'user-1',
      newPassword: 'same-password-123',
    });

    expect(result).toEqual({ ok: false, reason: 'password_reuse' });
  });

  it('refuses missing, deleted and disabled users', async () => {
    const missing = createStore(activeUser());
    missing.findUser = async () => null;
    await expect(
      changePassword(missing, hashPassword, { userId: 'x', newPassword: 'brand-new-password-1' }),
    ).resolves.toEqual({ ok: false, reason: 'user_not_found' });

    const deleted = createStore(activeUser({ deletedAt: new Date('2026-01-01T00:00:00Z') }));
    await expect(
      changePassword(deleted, hashPassword, {
        userId: 'user-1',
        newPassword: 'brand-new-password-1',
      }),
    ).resolves.toEqual({ ok: false, reason: 'user_not_found' });

    const disabled = createStore(activeUser({ status: 'disabled' }));
    await expect(
      changePassword(disabled, hashPassword, {
        userId: 'user-1',
        newPassword: 'brand-new-password-1',
      }),
    ).resolves.toEqual({ ok: false, reason: 'user_disabled' });
  });

  it('allows an admin reset without the current password', async () => {
    const store = createStore(activeUser({ passwordHash: null }));
    const result = await changePassword(
      store,
      hashPassword,
      {
        userId: 'user-1',
        newPassword: 'admin-set-password-9',
        actorType: 'admin',
        actorId: 'admin-1',
      },
      now,
    );

    expect(result.ok).toBe(true);
    expect(store.audits[0]).toMatchObject({ actorType: 'admin', actorId: 'admin-1' });
  });

  it('uses the injected clock for the change timestamp', async () => {
    const store = createStore(activeUser());
    await changePassword(
      store,
      hashPassword,
      { userId: 'user-1', newPassword: 'clock-test-pass-1' },
      now,
    );
    expect(store.changedAt).toEqual(now());
  });
});

describe('sanitizeAuditMetadata', () => {
  it('removes secret-looking keys at every depth', () => {
    const sanitized = sanitizeAuditMetadata({
      password: 'secret',
      nested: { passwordHash: 'x', keep: 'ok' },
      list: [{ token: 'secret', keep: 1 }],
      action: 'visible',
    });

    expect(sanitized).toEqual({ nested: { keep: 'ok' }, list: [{ keep: 1 }], action: 'visible' });
  });

  it('returns an empty object for missing metadata', () => {
    expect(sanitizeAuditMetadata(undefined)).toEqual({});
  });
});
