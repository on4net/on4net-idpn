/** Fixed-window rate limiting shared by the account lifecycle endpoints (docs/security.md 3.2). */
export interface RateLimitPolicy {
  windowSeconds: number;
  max: number;
}

export interface RateLimiter {
  /** Records one attempt; `false` means the caller must answer `429`. */
  consume(key: string, policy: RateLimitPolicy): Promise<boolean>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Single-process limiter for tests and single-instance deployments. */
export function createMemoryRateLimiter(nowMs: () => number = Date.now): RateLimiter & {
  reset(): void;
} {
  const buckets = new Map<string, Bucket>();
  return {
    async consume(key, policy) {
      const at = nowMs();
      const bucket = buckets.get(key);
      if (bucket === undefined || bucket.resetAt <= at) {
        buckets.set(key, { count: 1, resetAt: at + policy.windowSeconds * 1000 });
        return true;
      }
      if (bucket.count >= policy.max) {
        return false;
      }
      bucket.count += 1;
      return true;
    },
    reset() {
      buckets.clear();
    },
  };
}

interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
}

/**
 * Redis fixed window so every API instance shares one counter. A Redis outage fails open:
 * account recovery must not depend on the limiter, and `RedisSessionStore` already fails
 * closed for authenticated traffic.
 */
export function createRedisRateLimiter(redis: RedisLike, prefix = 'idpn:rate-limit:'): RateLimiter {
  return {
    async consume(key, policy) {
      try {
        const counterKey = `${prefix}${key}`;
        const count = await redis.incr(counterKey);
        if (count === 1) {
          await redis.pexpire(counterKey, policy.windowSeconds * 1000);
        }
        return count <= policy.max;
      } catch {
        return true;
      }
    },
  };
}
