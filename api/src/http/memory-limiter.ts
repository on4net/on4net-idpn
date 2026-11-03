/**
 * In-memory fixed-window limiter shared by the unauthenticated endpoints that cannot rely on
 * Redis (social login, CSP reports). Bounded in memory, IPv6-aware and never lets a flood of
 * new keys evict a throttled one (see `consume`).
 */

export interface Bucket {
  count: number;
  /** Limit that applies to this bucket, so "throttled" can be decided without the caller. */
  max: number;
  resetAt: number;
}

/** Upper bound for the in-memory limiter so spraying source addresses cannot grow it forever. */
export const MAX_BUCKETS = 10_000;

/** Drops expired buckets only. A live bucket is never evicted: that would reset a throttle. */
function pruneBuckets(buckets: Map<string, Bucket>, nowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= nowMs) {
      buckets.delete(key);
    }
  }
}

/** Prefix of the reserved shared buckets that new keys are charged to while the map is full. */
const OVERFLOW_KEY = '\u0000overflow';
/**
 * The overflow is sharded by a hash of the key, so a source that exhausts its shard leaves the
 * other 15/16 of the newcomer capacity intact. A shared store (Redis) is the lasting answer;
 * this keeps the in-memory fallback from being a single point an attacker can drain.
 */
const OVERFLOW_SHARDS = 16;

/** Shard of the overflow bucket a key is charged to (FNV-1a, stable across restarts). */
export function overflowShard(key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193) >>> 0;
  }
  return `${OVERFLOW_KEY}:${String(hash % OVERFLOW_SHARDS)}`;
}
/** The overflow bucket admits this many times the per-key limit across all unknown keys. */
const OVERFLOW_FACTOR = 20;

/**
 * Groups IPv6 addresses by /64: a single subscriber controls a whole /64, so per-address
 * buckets would let one host mint 2^64 keys. IPv4 (and IPv4-mapped) addresses are kept whole.
 */
export function limiterAddress(ip: string): string {
  if (!ip.includes(':') || ip.toLowerCase().startsWith('::ffff:')) {
    return ip;
  }
  const [head = ''] = ip.toLowerCase().split('%');
  const [left = '', right] = head.split('::');
  const groups = left === '' ? [] : left.split(':');
  if (right === undefined && groups.length >= 4) {
    return `${groups.slice(0, 4).join(':')}::/64`;
  }
  const padded = [...groups, ...Array.from({ length: Math.max(0, 4 - groups.length) }, () => '0')];
  return `${padded.slice(0, 4).join(':')}::/64`;
}

export function consume(
  buckets: Map<string, Bucket>,
  key: string,
  limit: { windowSeconds: number; max: number },
  nowMs: number,
): boolean {
  const bucket = buckets.get(key);
  if (bucket === undefined || bucket.resetAt <= nowMs) {
    if (bucket === undefined && !key.startsWith(OVERFLOW_KEY) && buckets.size >= MAX_BUCKETS) {
      pruneBuckets(buckets, nowMs);
      if (buckets.size >= MAX_BUCKETS) {
        // Full of live buckets: neither evict one (that would let a caller reset its own
        // throttle) nor reject every newcomer (that would let a flood lock everyone out).
        // Newcomers share one coarse bucket instead, so the service degrades to a global
        // ceiling rather than to "no limit" or "no service".
        return consume(
          buckets,
          overflowShard(key),
          { windowSeconds: limit.windowSeconds, max: limit.max * OVERFLOW_FACTOR },
          nowMs,
        );
      }
    }
    buckets.set(key, { count: 1, max: limit.max, resetAt: nowMs + limit.windowSeconds * 1000 });
    return true;
  }
  if (bucket.count >= limit.max) {
    return false;
  }
  bucket.count += 1;
  return true;
}
