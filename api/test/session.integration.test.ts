import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RedisSessionCache } from '../src/session/redis-cache.js';
import { RedisSessionStore } from '../src/session/store.js';

const policy = { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 };

let container: StartedRedisContainer | undefined;
let redis: Redis;

beforeAll(async () => {
  const external = process.env.TEST_REDIS_URL;
  if (external !== undefined && external !== '') {
    redis = new Redis(external);
  } else {
    container = await new RedisContainer('redis:7-alpine').withStartupTimeout(180_000).start();
    redis = new Redis(container.getConnectionUrl());
  }
}, 300_000);

afterAll(async () => {
  await redis?.quit();
  await container?.stop();
});

describe('RedisSessionStore against Redis', () => {
  it('persists, reads and expires sessions using real TTLs', async () => {
    const store = new RedisSessionStore({ cache: new RedisSessionCache(redis), policy });

    const session = await store.create({
      userId: 'user-redis',
      amr: ['pwd'],
      acr: 'urn:on4net:acr:pwd',
    });

    const raw = await redis.get(`idpn:sess:${session.sid}`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? '{}')).toMatchObject({ userId: 'user-redis', sid: session.sid });

    const ttl = await redis.ttl(`idpn:sess:${session.sid}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(policy.idleTtlSeconds);

    const members = await redis.smembers('idpn:user-sessions:user-redis');
    expect(members).toContain(session.sid);

    await expect(store.read(session.sid)).resolves.toMatchObject({ userId: 'user-redis' });
    await expect(store.revoke(session.sid, 'logout')).resolves.toBe(true);
    await expect(store.read(session.sid)).resolves.toBeNull();

    const revoked = JSON.parse((await redis.get(`idpn:sess:${session.sid}`)) ?? '{}');
    expect(revoked.revokeReason).toBe('logout');
    const graceTtl = await redis.ttl(`idpn:sess:${session.sid}`);
    expect(graceTtl).toBeGreaterThan(0);
    expect(graceTtl).toBeLessThanOrEqual(60);
    expect(await redis.smembers('idpn:user-sessions:user-redis')).toEqual([]);
  }, 60_000);

  it('revokes every session in Redis for a user', async () => {
    const store = new RedisSessionStore({ cache: new RedisSessionCache(redis), policy });
    const a = await store.create({ userId: 'user-redis-2', amr: ['pwd'], acr: 'pwd' });
    const b = await store.create({ userId: 'user-redis-2', amr: ['pwd'], acr: 'pwd' });

    await expect(store.revokeAllForUser('user-redis-2', 'password_change')).resolves.toBe(2);
    await expect(store.read(a.sid)).resolves.toBeNull();
    await expect(store.read(b.sid)).resolves.toBeNull();
  }, 60_000);

  it('rotates inside Redis without leaving the old key alive', async () => {
    const store = new RedisSessionStore({ cache: new RedisSessionCache(redis), policy });
    const original = await store.create({ userId: 'user-redis-3', amr: ['pwd'], acr: 'pwd' });

    const rotated = await store.rotate(original.sid);

    expect(rotated?.sid).not.toBe(original.sid);
    await expect(store.read(original.sid)).resolves.toBeNull();
    const rotatedRaw = await redis.get(`idpn:sess:${rotated?.sid ?? ''}`);
    expect(rotatedRaw).not.toBeNull();
  }, 60_000);

  it('drops expired sessions on the next request', async () => {
    const clock = { now: new Date('2026-10-18T10:00:00Z') };
    const now = vi.fn(() => clock.now);
    const store = new RedisSessionStore({
      cache: new RedisSessionCache(redis),
      policy,
      now,
    });
    const session = await store.create({ userId: 'user-redis-4', amr: ['pwd'], acr: 'pwd' });

    clock.now = new Date('2026-10-18T10:20:00Z');

    await expect(store.read(session.sid)).resolves.toBeNull();
    expect(await redis.get(`idpn:sess:${session.sid}`)).toBeNull();
  }, 60_000);
});
