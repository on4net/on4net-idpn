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

  it('evicts a caller that is under its limit, never a throttled one', () => {
    const buckets = new Map();
    consume(buckets, 'attacker', limit, 0);
    consume(buckets, 'attacker', limit, 0);
    expect(consume(buckets, 'attacker', limit, 0)).toBe(false);
    for (let index = 0; buckets.size < MAX_BUCKETS; index += 1) {
      consume(buckets, `filler-${String(index)}`, limit, 0);
    }
    // A new key still gets in: one idle bucket is forgotten to make room, so a flood of
    // distinct keys cannot lock every other caller out.
    expect(consume(buckets, 'brand-new', limit, 1)).toBe(true);
    expect(buckets.size).toBe(MAX_BUCKETS);
    // The throttled bucket survived, so the flood did not reset it.
    expect(consume(buckets, 'attacker', limit, 2)).toBe(false);
  });

  it('fails closed only when every bucket is throttled', () => {
    const buckets = new Map();
    for (let index = 0; buckets.size < MAX_BUCKETS; index += 1) {
      const key = `hot-${String(index)}`;
      consume(buckets, key, limit, 0);
      consume(buckets, key, limit, 0);
    }
    expect(consume(buckets, 'brand-new', limit, 1)).toBe(false);
    expect(buckets.has('brand-new')).toBe(false);
    // Windows expire, the map is pruned, new keys are admitted again.
    expect(consume(buckets, 'brand-new', limit, 61_000)).toBe(true);
  });
});
