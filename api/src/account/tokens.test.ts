import { describe, expect, it } from 'vitest';

import { hashOpaqueToken } from '../auth/opaque-token.js';
import {
  ACCOUNT_TOKEN_TTL_MS,
  consumeAccountToken,
  issueAccountToken,
  peekAccountToken,
  type AccountTokenRecord,
  type AccountTokenStore,
  type TokenConsumption,
} from './tokens.js';

interface StoredToken extends AccountTokenRecord {
  tokenHash: string;
}

/** Mirrors the conditional-update semantics of the Prisma store. */
function memoryStore(): AccountTokenStore & { rows: StoredToken[] } {
  const rows: StoredToken[] = [];
  return {
    rows,
    async create(input) {
      rows.push({
        userId: input.userId,
        purpose: input.purpose,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        consumedAt: null,
      });
    },
    async invalidateActive(userId, purpose, at) {
      let count = 0;
      for (const row of rows) {
        if (row.userId === userId && row.purpose === purpose && row.consumedAt === null) {
          row.consumedAt = at;
          count += 1;
        }
      }
      return count;
    },
    async findByHash(tokenHash) {
      const row = rows.find((entry) => entry.tokenHash === tokenHash);
      return row === undefined
        ? null
        : {
            userId: row.userId,
            purpose: row.purpose,
            expiresAt: row.expiresAt,
            consumedAt: row.consumedAt,
          };
    },
    async consume(tokenHash, purpose, at, expectedUserId): Promise<TokenConsumption> {
      const row = rows.find((entry) => entry.tokenHash === tokenHash);
      if (row === null || row === undefined || row.purpose !== purpose) {
        return { ok: false, reason: 'invalid' };
      }
      if (expectedUserId !== undefined && row.userId !== expectedUserId) {
        return { ok: false, reason: 'wrong_user' };
      }
      if (row.consumedAt !== null) {
        return { ok: false, reason: 'used' };
      }
      if (row.expiresAt.getTime() <= at.getTime()) {
        return { ok: false, reason: 'expired' };
      }
      row.consumedAt = at;
      return { ok: true, userId: row.userId };
    },
    async purge({ now, retainDays }) {
      const cutoff = new Date(now.getTime() - (retainDays ?? 30) * 24 * 60 * 60 * 1000);
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]!;
        if (
          (row.consumedAt !== null && row.consumedAt.getTime() < cutoff.getTime()) ||
          row.expiresAt.getTime() < cutoff.getTime()
        ) {
          rows.splice(index, 1);
        }
      }
      return before - rows.length;
    },
  };
}

const at = new Date('2026-10-19T10:00:00.000Z');
const later = (ms: number): Date => new Date(at.getTime() + ms);

describe('account token retention', () => {
  it('purges consumed and long-expired tokens but keeps live ones', async () => {
    const store = memoryStore();
    const live = await issueAccountToken(store, { userId: 'user-1', purpose: 'password_reset' }, () => at);

    const oldConsumed = await issueAccountToken(store, { userId: 'user-1', purpose: 'invite' }, () => at);
    const consumedToken = store.rows.find((row) => row.tokenHash === hashOpaqueToken(oldConsumed.token));
    consumedToken!.consumedAt = new Date('2026-08-01T00:00:00.000Z');

    const longExpired = await issueAccountToken(
      store,
      { userId: 'user-2', purpose: 'email_verification' },
      () => new Date('2026-08-01T00:00:00.000Z'),
    );

    const deleted = await store.purge({ now: at, retainDays: 30 });

    expect(deleted).toBe(2);
    expect(store.rows.map((row) => row.tokenHash)).toEqual([hashOpaqueToken(live.token)]);
    expect(store.rows.some((row) => row.tokenHash === hashOpaqueToken(longExpired.token))).toBe(
      false,
    );
  });

  it('keeps a token that expired inside the retention window', async () => {
    const store = memoryStore();
    const issued = await issueAccountToken(
      store,
      { userId: 'user-1', purpose: 'password_reset' },
      () => new Date(at.getTime() - 31 * 60 * 1000),
    );

    expect(await store.purge({ now: at, retainDays: 30 })).toBe(0);
    expect(store.rows.some((row) => row.tokenHash === hashOpaqueToken(issued.token))).toBe(true);
  });
});

describe('account token lifecycle', () => {
  it('stores only the hash and never the emailed token', async () => {
    const store = memoryStore();
    const issued = await issueAccountToken(
      store,
      { userId: 'user-1', purpose: 'password_reset' },
      () => at,
    );

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.tokenHash).toBe(hashOpaqueToken(issued.token));
    expect(store.rows[0]?.tokenHash).not.toBe(issued.token);
    expect(JSON.stringify(store.rows)).not.toContain(issued.token);
  });

  it.each([
    ['invite', 72 * 60 * 60 * 1000],
    ['email_verification', 24 * 60 * 60 * 1000],
    ['password_reset', 30 * 60 * 1000],
  ] as const)('applies the documented TTL for %s', async (purpose, ttl) => {
    const store = memoryStore();
    const issued = await issueAccountToken(store, { userId: 'user-1', purpose }, () => at);

    expect(ACCOUNT_TOKEN_TTL_MS[purpose]).toBe(ttl);
    expect(issued.expiresAt.getTime() - at.getTime()).toBe(ttl);
  });

  it('consumes a token exactly once', async () => {
    const store = memoryStore();
    const issued = await issueAccountToken(
      store,
      { userId: 'user-1', purpose: 'email_verification' },
      () => at,
    );

    await expect(
      consumeAccountToken(store, issued.token, 'email_verification', { now: () => at }),
    ).resolves.toEqual({ ok: true, userId: 'user-1' });
    await expect(
      consumeAccountToken(store, issued.token, 'email_verification', { now: () => at }),
    ).resolves.toEqual({ ok: false, reason: 'used' });
  });

  it('rejects an expired token', async () => {
    const store = memoryStore();
    const issued = await issueAccountToken(
      store,
      { userId: 'user-1', purpose: 'password_reset' },
      () => at,
    );

    await expect(
      consumeAccountToken(store, issued.token, 'password_reset', {
        now: () => later(ACCOUNT_TOKEN_TTL_MS.password_reset),
      }),
    ).resolves.toEqual({ ok: false, reason: 'expired' });
    await expect(
      consumeAccountToken(store, issued.token, 'password_reset', {
        now: () => later(ACCOUNT_TOKEN_TTL_MS.password_reset - 1),
      }),
    ).resolves.toEqual({ ok: true, userId: 'user-1' });
  });

  it('does not consume a token presented for another user', async () => {
    const store = memoryStore();
    const issued = await issueAccountToken(
      store,
      { userId: 'user-1', purpose: 'password_reset' },
      () => at,
    );

    await expect(
      consumeAccountToken(store, issued.token, 'password_reset', {
        now: () => at,
        expectedUserId: 'user-2',
      }),
    ).resolves.toEqual({ ok: false, reason: 'wrong_user' });
    // The legitimate holder can still use the link.
    await expect(
      consumeAccountToken(store, issued.token, 'password_reset', {
        now: () => at,
        expectedUserId: 'user-1',
      }),
    ).resolves.toEqual({ ok: true, userId: 'user-1' });
  });

  it('rejects a token used for a different purpose', async () => {
    const store = memoryStore();
    const issued = await issueAccountToken(
      store,
      { userId: 'user-1', purpose: 'invite' },
      () => at,
    );

    await expect(
      consumeAccountToken(store, issued.token, 'password_reset', { now: () => at }),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(
      peekAccountToken(store, issued.token, 'password_reset', { now: () => at }),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('invalidates the previous link when a new one is issued', async () => {
    const store = memoryStore();
    const first = await issueAccountToken(
      store,
      { userId: 'user-1', purpose: 'password_reset' },
      () => at,
    );
    const second = await issueAccountToken(
      store,
      { userId: 'user-1', purpose: 'password_reset' },
      () => later(1000),
    );

    await expect(
      consumeAccountToken(store, first.token, 'password_reset', {
        now: () => later(2000),
      }),
    ).resolves.toEqual({ ok: false, reason: 'used' });
    await expect(
      consumeAccountToken(store, second.token, 'password_reset', {
        now: () => later(2000),
      }),
    ).resolves.toEqual({ ok: true, userId: 'user-1' });
  });

  it('never mutates a token while peeking', async () => {
    const store = memoryStore();
    const issued = await issueAccountToken(
      store,
      { userId: 'user-1', purpose: 'invite' },
      () => at,
    );

    await expect(
      peekAccountToken(store, issued.token, 'invite', { now: () => at }),
    ).resolves.toEqual({ ok: true, userId: 'user-1' });
    expect(store.rows[0]?.consumedAt).toBeNull();
  });
});
