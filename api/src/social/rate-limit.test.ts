import { describe, expect, it } from 'vitest';

import { consume, limiterAddress, MAX_BUCKETS } from './routes.js';

const limit = { windowSeconds: 60, max: 2 };

describe('social limiter', () => {
  it('groups IPv6 addresses by /64 and keeps IPv4 whole', () => {
    expect(limiterAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(limiterAddress('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7');
    expect(limiterAddress('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(limiterAddress('2001:DB8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(limiterAddress('2001:db8:1:2:ffff::9')).toBe(limiterAddress('2001:db8:1:2::1'));
    expect(limiterAddress('2001:db8:1:3::1')).not.toBe(limiterAddress('2001:db8:1:2::1'));
  });

  it('counts down inside a window and recovers after it', () => {
    const buckets = new Map();
    expect(consume(buckets, 'a', limit, 0)).toBe(true);
    expect(consume(buckets, 'a', limit, 1)).toBe(true);
    expect(consume(buckets, 'a', limit, 2)).toBe(false);
    expect(consume(buckets, 'a', limit, 61_000)).toBe(true);
  });

  const fill = (buckets: Map<string, unknown>, hits: number) => {
    for (let index = 0; buckets.size < MAX_BUCKETS; index += 1) {
      for (let hit = 0; hit < hits; hit += 1) {
        consume(buckets as never, `filler-${String(index)}`, limit, 0);
      }
    }
  };

  it('never evicts a live bucket, throttled or not, to admit a new key', () => {
    const buckets = new Map();
    consume(buckets, 'attacker', limit, 0);
    consume(buckets, 'attacker', limit, 0);
    expect(consume(buckets, 'attacker', limit, 0)).toBe(false);
    consume(buckets, 'polite', limit, 0);
    fill(buckets, 1);

    consume(buckets, 'brand-new', limit, 1);
    expect(buckets.has('brand-new')).toBe(false);
    expect(buckets.has('polite')).toBe(true);
    // The flood did not reset the throttled bucket.
    expect(consume(buckets, 'attacker', limit, 2)).toBe(false);
  });

  it('charges newcomers to one shared bucket while full, so the service degrades instead of locking', () => {
    const buckets = new Map();
    fill(buckets, 1);
    // limit.max (2) * 20 newcomers fit in the shared overflow bucket, then it throttles.
    const results = Array.from({ length: 45 }, (_, index) =>
      consume(buckets, `newcomer-${String(index)}`, limit, 1),
    );
    expect(results.filter(Boolean)).toHaveLength(40);
    expect(results.slice(40).every((allowed) => !allowed)).toBe(true);
    // Existing callers are unaffected by the overflow being exhausted.
    expect(consume(buckets, 'filler-0', limit, 2)).toBe(true);
  });

  it('prunes expired buckets so newcomers get their own bucket again', () => {
    const buckets = new Map();
    fill(buckets, 1);
    expect(consume(buckets, 'brand-new', limit, 61_000)).toBe(true);
    expect(buckets.has('brand-new')).toBe(true);
  });
});
