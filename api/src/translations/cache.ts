import type { BundleCacheInvalidator } from '../admin/translations/translation-types.js';

/**
 * Cache for the public translation bundle (docs/localization.md 6.2 and 11).
 *
 * A Redis outage must not take the bundle down: reads fall through to PostgreSQL and writes
 * are best effort. TTL is short (matching `Cache-Control: max-age`) and the admin write path
 * deletes the affected keys, so a missed invalidation still expires quickly.
 */
export interface BundleCache extends BundleCacheInvalidator {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export const BUNDLE_CACHE_PREFIX = 'idpn:translations:bundle:';
export const BUNDLE_CACHE_TTL_SECONDS = 300;

export function bundleCacheKey(clientId: string, locale: string): string {
  return `${BUNDLE_CACHE_PREFIX}${clientId}:${locale.toLowerCase()}`;
}

/** Redis subset used by the cache; declared structurally so ioredis types stay internal. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<number>;
}

export function createRedisBundleCache(redis: RedisLike): BundleCache {
  return {
    async get(key) {
      try {
        return await redis.get(key);
      } catch {
        return null;
      }
    },
    async set(key, value, ttlSeconds) {
      try {
        await redis.set(key, value, 'EX', Math.max(1, Math.ceil(ttlSeconds)));
      } catch {
        // Best effort: the response is still correct, it just is not cached.
      }
    },
    async delete(key) {
      try {
        await redis.del(key);
      } catch {
        // Same as set: invalidation failure degrades to the short TTL.
      }
    },
  };
}

/** Single-process cache for tests and single-instance deployments without Redis. */
export function createMemoryBundleCache(): BundleCache & { clear(): void } {
  const entries = new Map<string, string>();
  return {
    async get(key) {
      return entries.get(key) ?? null;
    },
    async set(key, value) {
      entries.set(key, value);
    },
    async delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}
