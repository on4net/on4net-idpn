import type { IndexedSessionWrite, SessionCache } from './cache.js';

/** Subset of the Redis client used here, declared structurally to avoid leaking ioredis types. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<number>;
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Session write plus user-index membership in one round trip. `redis.call` failures inside a
 * script abort the whole script, so the pair is all-or-nothing (card #70 finding 5b).
 */
const SET_WITH_INDEX = `
local ttl = tonumber(ARGV[2])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
return 1
`;

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

  async setWithIndex(write: IndexedSessionWrite): Promise<void> {
    await this.redis.eval(
      SET_WITH_INDEX,
      2,
      write.key,
      write.indexKey,
      write.value,
      Math.max(1, Math.ceil(write.ttlSeconds)),
      write.member,
      Math.max(1, Math.ceil(write.indexTtlSeconds)),
    );
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
