import type { SessionCache } from './cache.js';

/** Subset of the Redis client used here, declared structurally to avoid leaking ioredis types. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<number>;
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
}

/** Redis-backed cache used by the session store. */
export class RedisSessionCache implements SessionCache {
  constructor(private readonly redis: RedisLike) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', Math.max(1, Math.ceil(ttlSeconds)));
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async setAdd(key: string, member: string, ttlSeconds: number): Promise<void> {
    await this.redis.sadd(key, member);
    await this.redis.expire(key, Math.max(1, Math.ceil(ttlSeconds)));
  }

  async setRemove(key: string, member: string): Promise<void> {
    await this.redis.srem(key, member);
  }

  async setMembers(key: string): Promise<string[]> {
    return this.redis.smembers(key);
  }
}
