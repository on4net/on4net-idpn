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

interface RedisPipelineLike {
  incr(key: string): RedisPipelineLike;
  pexpire(key: string, milliseconds: number, mode?: 'NX'): RedisPipelineLike;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

interface RedisLike {
  multi(): RedisPipelineLike;
}

/**
 * Redis fixed window so every API instance shares one counter. `INCR` and `PEXPIRE` are sent
 * in one `MULTI`/`EXEC`: a counter that is incremented without ever receiving a TTL would
 * never reset and would lock the caller out permanently. `PEXPIRE … NX` keeps the window that
 * the first increment started. A Redis outage fails open: account recovery must not depend on
 * the limiter, and `RedisSessionStore` already fails closed for authenticated traffic.
 */
export function createRedisRateLimiter(redis: RedisLike, prefix = 'idpn:rate-limit:'): RateLimiter {
  return {
    async consume(key, policy) {
      try {
        const counterKey = `${prefix}${key}`;
        const results = await redis
          .multi()
          .incr(counterKey)
          .pexpire(counterKey, policy.windowSeconds * 1000, 'NX')
          .exec();
        if (results === null) {
          return true;
        }
        const [incremented] = results;
        if (incremented === undefined || incremented[0] !== null) {
          return true;
        }
        const count = Number(incremented[1]);
        return !Number.isFinite(count) || count <= policy.max;
      } catch {
        return true;
      }
    },
  };
}
