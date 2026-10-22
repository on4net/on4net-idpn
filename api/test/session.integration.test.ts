import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RedisSessionCache } from '../src/session/redis-cache.js';
import { RedisSessionStore } from '../src/session/store.js';
import { createRedisRateLimiter } from '../src/http/rate-limit.js';

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

  it('write-behinds the idle slide for the PostgreSQL mirror, throttled per sid', async () => {
    const clock = { now: new Date('2026-10-18T10:00:00Z') };
    const mirrored: Array<{ sid: string; idleExpiresAt: string }> = [];
    const store = new RedisSessionStore({
      cache: new RedisSessionCache(redis),
      policy,
      now: () => clock.now,
      onSlide: (session) => {
        mirrored.push({ sid: session.sid, idleExpiresAt: session.idleExpiresAt });
      },
    });
    const session = await store.create({ userId: 'user-redis-5', amr: ['pwd'], acr: 'pwd' });
    const created = await store.read(session.sid);
    expect(created).not.toBeNull();
    expect(mirrored).toHaveLength(1);

    // Inside the throttle window nothing new is written, even though Redis slid the expiry.
    clock.now = new Date('2026-10-18T10:00:30Z');
    await store.read(session.sid);
    expect(mirrored).toHaveLength(1);

    // Past the window the slide is mirrored with the slid expiry, not the creation-time one.
    clock.now = new Date('2026-10-18T10:02:00Z');
    const slid = await store.read(session.sid);
    expect(mirrored).toHaveLength(2);
    expect(mirrored[1]?.idleExpiresAt).toBe(slid?.idleExpiresAt);
    expect(new Date(mirrored[1]!.idleExpiresAt).getTime()).toBeGreaterThan(
      new Date(created!.idleExpiresAt).getTime(),
    );
  }, 60_000);

  it('keeps the session alive when the mirror write fails', async () => {
    const store = new RedisSessionStore({
      cache: new RedisSessionCache(redis),
      policy,
      onSlide: () => {
        throw new Error('postgres down');
      },
    });
    const session = await store.create({ userId: 'user-redis-6', amr: ['pwd'], acr: 'pwd' });

    await expect(store.read(session.sid)).resolves.toMatchObject({ userId: 'user-redis-6' });
  }, 60_000);
});

describe('Redis rate limiter against Redis', () => {
  it('increments and sets the window TTL in one transaction', async () => {
    const limiter = createRedisRateLimiter(redis, 'idpn:test-rate-limit:');
    const policy = { windowSeconds: 60, max: 2 };
    const key = `bucket-${Date.now()}`;

    await expect(limiter.consume(key, policy)).resolves.toBe(true);
    // The counter must never exist without a TTL, otherwise the window never resets.
    const ttl = await redis.pttl(`idpn:test-rate-limit:${key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);

    await expect(limiter.consume(key, policy)).resolves.toBe(true);
    await expect(limiter.consume(key, policy)).resolves.toBe(false);
    expect(await redis.get(`idpn:test-rate-limit:${key}`)).toBe('3');
  }, 60_000);

  it('reports a distinct window per key so one client cannot lock another out', async () => {
    const limiter = createRedisRateLimiter(redis, 'idpn:test-rate-limit:');
    const policy = { windowSeconds: 60, max: 1 };
    const left = `left-${Date.now()}`;
    const right = `right-${Date.now()}`;

    await limiter.consume(left, policy);
    await limiter.consume(left, policy);
    await expect(limiter.consume(right, policy)).resolves.toBe(true);
  }, 60_000);

  it('fails open when Redis is unavailable', async () => {
    const broken = {
      multi() {
        throw new Error('connection lost');
      },
    };
    const limiter = createRedisRateLimiter(broken as never, 'idpn:test-rate-limit:');

    await expect(limiter.consume('any', { windowSeconds: 60, max: 1 })).resolves.toBe(true);
  });
});
