import { describe, expect, it } from 'vitest';

import type { SessionCache } from './cache.js';
import { RedisSessionStore } from './store.js';

/** In-memory SessionCache with manual TTL bookkeeping (tests only). */
function createMemoryCache() {
  const values = new Map<string, { value: string; expiresAt: number }>();
  const sets = new Map<string, Set<string>>();
  const cache: SessionCache = {
    async get(key) {
      const entry = values.get(key);
      if (entry === undefined) {
        return null;
      }
      if (entry.expiresAt <= Date.now()) {
        values.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      values.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async delete(key) {
      values.delete(key);
    },
    async setAdd(key, member) {
      const set = sets.get(key) ?? new Set<string>();
      set.add(member);
      sets.set(key, set);
    },
    async setRemove(key, member) {
      sets.get(key)?.delete(member);
    },
    async setMembers(key) {
      return [...(sets.get(key) ?? [])];
    },
  };
  return { cache, values, sets };
}

const policy = { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 };

describe('RedisSessionStore', () => {
  it('creates a session with a random sid and stores it with a TTL', async () => {
    const { cache, values } = createMemoryCache();
    const store = new RedisSessionStore({ cache, policy });

    const session = await store.create({
      userId: 'user-1',
      amr: ['pwd'],
      acr: 'urn:on4net:acr:pwd',
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });

    expect(session.sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.userId).toBe('user-1');
    expect(values.has(`idpn:sess:${session.sid}`)).toBe(true);
    expect(await store.read(session.sid)).toMatchObject({ userId: 'user-1', ip: '10.0.0.1' });
  });

  it('never reuses a session id across logins (session fixation)', async () => {
    const { cache } = createMemoryCache();
    const store = new RedisSessionStore({ cache, policy });

    const first = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });
    const second = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });

    expect(first.sid).not.toBe(second.sid);
  });

  it('rotates the session id and revokes the previous one', async () => {
    const { cache } = createMemoryCache();
    const store = new RedisSessionStore({ cache, policy });

    const original = await store.create({
      userId: 'user-1',
      amr: ['pwd'],
      acr: 'pwd',
      loginContext: 'customer-admin',
    });
    const rotated = await store.rotate(original.sid);

    expect(rotated).not.toBeNull();
    expect(rotated?.sid).not.toBe(original.sid);
    expect(rotated?.loginContext).toBe('customer-admin');
    // The hard limit counts from the original authentication, not from the rotation.
    expect(rotated?.absoluteExpiresAt).toBe(original.absoluteExpiresAt);
    expect(await store.read(original.sid)).toBeNull();
    expect(await store.read(rotated?.sid ?? '')).not.toBeNull();
  });

  it('records the context a session switches into without rotating or re-authenticating', async () => {
    const { cache } = createMemoryCache();
    const store = new RedisSessionStore({ cache, policy });

    const session = await store.create({
      userId: 'user-1',
      clientId: 'app-a',
      loginContext: 'customer-admin',
      amr: ['pwd'],
      acr: 'pwd',
      authTime: new Date('2026-10-19T08:00:00.000Z'),
    });

    const rebound = await store.rebindContext(session.sid, 'customer-team');

    expect(rebound?.sid).toBe(session.sid);
    expect(rebound?.loginContext).toBe('customer-team');
    // Switching is not a new authentication: the freshness inputs must survive.
    expect(rebound?.authTime).toBe('2026-10-19T08:00:00.000Z');
    expect(rebound?.amr).toEqual(['pwd']);
    expect(rebound?.acr).toBe('pwd');
    await expect(store.read(session.sid)).resolves.toMatchObject({
      loginContext: 'customer-team',
    });
    // The move is context-scoped: the old context no longer owns the session.
    await expect(
      store.revokeForUserClientContext('user-1', 'app-a', 'customer-admin', 'admin'),
    ).resolves.toEqual([]);
    await expect(
      store.revokeForUserClientContext('user-1', 'app-a', 'customer-team', 'admin'),
    ).resolves.toEqual([session.sid]);
    await expect(store.rebindContext(session.sid, 'customer-admin')).resolves.toBeNull();
  });

  it('returns null for an unknown sid', async () => {
    const { cache } = createMemoryCache();
    const store = new RedisSessionStore({ cache, policy });

    await expect(store.read('00000000-0000-0000-0000-000000000000')).resolves.toBeNull();
  });

  it('expires the session after the idle timeout', async () => {
    const { cache } = createMemoryCache();
    let now = new Date('2026-10-18T10:00:00Z');
    const store = new RedisSessionStore({ cache, policy, now: () => now });

    const session = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });
    now = new Date('2026-10-18T10:11:00Z');

    await expect(store.read(session.sid)).resolves.toBeNull();
  });

  it('slides the idle timeout but never past the absolute timeout', async () => {
    const { cache } = createMemoryCache();
    const longIdle = { idleTtlSeconds: 7200, absoluteTtlSeconds: 600 };
    let now = new Date('2026-10-18T10:00:00Z');
    const store = new RedisSessionStore({ cache, policy: longIdle, now: () => now });

    const session = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });
    now = new Date('2026-10-18T10:05:00Z');
    const touched = await store.read(session.sid);

    expect(touched?.lastSeenAt).toBe(now.toISOString());
    // Idle would reach 12:05, but the absolute limit at 10:10 wins.
    expect(touched?.idleExpiresAt).toBe('2026-10-18T10:10:00.000Z');

    now = new Date('2026-10-18T10:10:01Z');
    await expect(store.read(session.sid)).resolves.toBeNull();
  });

  it('extends the idle timeout on activity within the window', async () => {
    const { cache } = createMemoryCache();
    let now = new Date('2026-10-18T10:00:00Z');
    const store = new RedisSessionStore({ cache, policy, now: () => now });

    const session = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });
    now = new Date('2026-10-18T10:05:00Z');
    expect((await store.read(session.sid))?.idleExpiresAt).toBe('2026-10-18T10:15:00.000Z');

    now = new Date('2026-10-18T10:14:00Z');
    expect((await store.read(session.sid))?.idleExpiresAt).toBe('2026-10-18T10:24:00.000Z');
  });

  it('revokes a session, keeps the reason briefly and rejects it afterwards', async () => {
    const { cache, values } = createMemoryCache();
    const store = new RedisSessionStore({ cache, policy });
    const session = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });

    await expect(store.revoke(session.sid, 'logout')).resolves.toBe(true);
    await expect(store.read(session.sid)).resolves.toBeNull();

    const stored = JSON.parse(values.get(`idpn:sess:${session.sid}`)?.value ?? '{}');
    expect(stored.revokeReason).toBe('logout');
    expect(stored.revokedAt).toBeDefined();

    await expect(store.revoke(session.sid, 'logout')).resolves.toBe(true);
  });

  it('revokes every session of a user', async () => {
    const { cache, sets } = createMemoryCache();
    const store = new RedisSessionStore({ cache, policy });
    const a = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });
    const b = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });
    const other = await store.create({ userId: 'user-2', amr: ['pwd'], acr: 'pwd' });

    await expect(store.revokeAllForUser('user-1', 'global_logout')).resolves.toBe(2);
    await expect(store.read(a.sid)).resolves.toBeNull();
    await expect(store.read(b.sid)).resolves.toBeNull();
    await expect(store.read(other.sid)).resolves.not.toBeNull();
    expect(sets.get('idpn:user-sessions:user-1')?.size ?? 0).toBe(0);
  });

  it('revokes every session of a user except the current one', async () => {
    const { cache, sets } = createMemoryCache();
    const store = new RedisSessionStore({ cache, policy });
    const current = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });
    const other = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });
    const unrelated = await store.create({ userId: 'user-2', amr: ['pwd'], acr: 'pwd' });

    await expect(
      store.revokeAllForUserExcept('user-1', current.sid, 'password_change'),
    ).resolves.toBe(1);
    await expect(store.read(current.sid)).resolves.not.toBeNull();
    await expect(store.read(other.sid)).resolves.toBeNull();
    await expect(store.read(unrelated.sid)).resolves.not.toBeNull();
    expect(sets.get('idpn:user-sessions:user-1')).toEqual(new Set([current.sid]));
  });

  it('writes the session and its user index entry in one cache call', async () => {
    const { cache, values, sets } = createMemoryCache();
    const writes: Parameters<NonNullable<SessionCache['setWithIndex']>>[0][] = [];
    const store = new RedisSessionStore({
      cache: {
        ...cache,
        async setWithIndex(write) {
          writes.push(write);
          await cache.set(write.key, write.value, write.ttlSeconds);
          await cache.setAdd(write.indexKey, write.member, write.indexTtlSeconds);
        },
      },
      policy,
    });

    const session = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      key: `idpn:sess:${session.sid}`,
      indexKey: 'idpn:user-sessions:user-1',
      member: session.sid,
      indexTtlSeconds: policy.absoluteTtlSeconds,
    });
    expect(values.has(`idpn:sess:${session.sid}`)).toBe(true);
    expect(sets.get('idpn:user-sessions:user-1')).toEqual(new Set([session.sid]));
  });

  it('rejects a session that the user index lost after a global revocation', async () => {
    const { cache, sets } = createMemoryCache();
    const store = new RedisSessionStore({ cache, policy });
    const session = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });

    // An evicted index key: the session record survives, the index no longer lists it, so the
    // index walk alone would never revoke it (card #70 finding 5b).
    sets.delete('idpn:user-sessions:user-1');
    await expect(store.revokeAllForUser('user-1', 'global_logout')).resolves.toBe(0);

    await expect(store.read(session.sid)).resolves.toBeNull();
  });

  it('lets the spared session outlive a global revocation whose index it lost', async () => {
    const { cache, sets } = createMemoryCache();
    const store = new RedisSessionStore({ cache, policy });
    const current = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });

    sets.delete('idpn:user-sessions:user-1');
    await store.revokeAllForUserExcept('user-1', current.sid, 'password_change');

    await expect(store.read(current.sid)).resolves.not.toBeNull();
  });

  it('revokes the oldest sessions when the concurrent limit is exceeded', async () => {
    const { cache } = createMemoryCache();
    let now = new Date('2026-10-18T10:00:00Z');
    const revoked: { sid: string; reason: string }[] = [];
    const store = new RedisSessionStore({
      cache,
      policy: { ...policy, maxConcurrentSessions: 2 },
      now: () => now,
      onRevoked: (session, reason) => {
        revoked.push({ sid: session.sid, reason });
      },
    });

    const first = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });
    now = new Date('2026-10-18T10:01:00Z');
    const second = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });
    now = new Date('2026-10-18T10:02:00Z');
    const third = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });

    await expect(store.read(first.sid)).resolves.toBeNull();
    await expect(store.read(second.sid)).resolves.not.toBeNull();
    await expect(store.read(third.sid)).resolves.not.toBeNull();
    expect(revoked).toEqual([{ sid: first.sid, reason: 'concurrent_limit' }]);
  });

  it('does not limit sessions when the configured maximum is zero', async () => {
    const { cache } = createMemoryCache();
    const store = new RedisSessionStore({
      cache,
      policy: { ...policy, maxConcurrentSessions: 0 },
    });

    const sessions = await Promise.all(
      Array.from({ length: 6 }, () => store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' })),
    );
    for (const session of sessions) {
      await expect(store.read(session.sid)).resolves.not.toBeNull();
    }
  });

  it('revokes only the sessions of one app for a suspension', async () => {
    const { cache } = createMemoryCache();
    const store = new RedisSessionStore({ cache, policy });

    const appA = await store.create({
      userId: 'user-1',
      clientId: 'app-a',
      amr: ['pwd'],
      acr: 'pwd',
    });
    const appB = await store.create({
      userId: 'user-1',
      clientId: 'app-b',
      amr: ['pwd'],
      acr: 'pwd',
    });
    const noApp = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });
    const otherUser = await store.create({
      userId: 'user-2',
      clientId: 'app-a',
      amr: ['pwd'],
      acr: 'pwd',
    });

    await expect(store.revokeForUserClient('user-1', 'app-a', 'admin')).resolves.toBe(1);
    await expect(store.read(appA.sid)).resolves.toBeNull();
    await expect(store.read(appB.sid)).resolves.not.toBeNull();
    await expect(store.read(noApp.sid)).resolves.not.toBeNull();
    await expect(store.read(otherUser.sid)).resolves.not.toBeNull();
  });

  it('revokes only the sessions of one login context for a context suspension', async () => {
    const { cache } = createMemoryCache();
    const store = new RedisSessionStore({ cache, policy });

    const adminContext = await store.create({
      userId: 'user-1',
      clientId: 'app-a',
      loginContext: 'customer-admin',
      amr: ['pwd'],
      acr: 'pwd',
    });
    const teamContext = await store.create({
      userId: 'user-1',
      clientId: 'app-a',
      loginContext: 'customer-team',
      amr: ['pwd'],
      acr: 'pwd',
    });
    const otherApp = await store.create({
      userId: 'user-1',
      clientId: 'app-b',
      loginContext: 'partner-portal',
      amr: ['pwd'],
      acr: 'pwd',
    });
    const noContext = await store.create({
      userId: 'user-1',
      clientId: 'app-a',
      amr: ['pwd'],
      acr: 'pwd',
    });

    await expect(
      store.revokeForUserClientContext('user-1', 'app-a', 'customer-admin', 'admin'),
    ).resolves.toEqual([adminContext.sid]);
    await expect(store.read(adminContext.sid)).resolves.toBeNull();
    await expect(store.read(teamContext.sid)).resolves.not.toBeNull();
    await expect(store.read(otherApp.sid)).resolves.not.toBeNull();
    await expect(store.read(noContext.sid)).resolves.not.toBeNull();
  });

  it('keeps a completed revocation when the audit hook fails', async () => {
    const { cache } = createMemoryCache();
    const store = new RedisSessionStore({
      cache,
      policy,
      onRevoked: () => {
        throw new Error('audit store unavailable');
      },
    });
    const session = await store.create({ userId: 'user-1', amr: ['pwd'], acr: 'pwd' });

    await expect(store.revoke(session.sid, 'admin')).resolves.toBe(true);
    await expect(store.read(session.sid)).resolves.toBeNull();
  });

  it('drops a corrupted cached payload instead of throwing', async () => {
    const { cache, values } = createMemoryCache();
    const store = new RedisSessionStore({ cache, policy });
    values.set('idpn:sess:broken', { value: '{not-json', expiresAt: Date.now() + 60_000 });

    await expect(store.read('broken')).resolves.toBeNull();
    expect(values.has('idpn:sess:broken')).toBe(false);
  });
});
