import { describe, expect, it } from 'vitest';

import {
  createMemoryTokenDenyList,
  createTokenDenyList,
  type DenyListStore,
} from './token-denylist.js';

const at = (iso: string) => () => new Date(iso);

describe('createTokenDenyList', () => {
  it('stores the jti with the remaining lifetime of the token', async () => {
    const written: { key: string; ttl: number }[] = [];
    const store: DenyListStore = {
      async get() {
        return null;
      },
      async set(key, _value, ttlSeconds) {
        written.push({ key, ttl: ttlSeconds });
      },
    };
    const denyList = createTokenDenyList(store, at('2026-10-18T12:00:00Z'));

    await denyList.deny('jti-1', Date.parse('2026-10-18T12:10:00Z') / 1000);

    expect(written).toEqual([{ key: 'idpn:jti-denied:jti-1', ttl: 600 }]);
  });

  it('does not store an already expired token', async () => {
    const written: string[] = [];
    const store: DenyListStore = {
      async get() {
        return null;
      },
      async set(key) {
        written.push(key);
      },
    };
    const denyList = createTokenDenyList(store, at('2026-10-18T12:00:00Z'));

    await denyList.deny('jti-1', Date.parse('2026-10-18T11:59:00Z') / 1000);

    expect(written).toEqual([]);
  });

  it('falls back to a default lifetime when the token has no usable exp', async () => {
    const written: number[] = [];
    const store: DenyListStore = {
      async get() {
        return null;
      },
      async set(_key, _value, ttlSeconds) {
        written.push(ttlSeconds);
      },
    };
    const denyList = createTokenDenyList(store, at('2026-10-18T12:00:00Z'));

    await denyList.deny('jti-1', Number.NaN);

    expect(written).toEqual([900]);
  });

  it('reports a jti as denied only while the stored entry exists', async () => {
    const entries = new Map<string, string>();
    const store: DenyListStore = {
      async get(key) {
        return entries.get(key) ?? null;
      },
      async set(key) {
        entries.set(key, '1');
      },
    };
    const denyList = createTokenDenyList(store, at('2026-10-18T12:00:00Z'));

    await expect(denyList.isDenied('jti-1')).resolves.toBe(false);
    await denyList.deny('jti-1', Date.parse('2026-10-18T12:10:00Z') / 1000);
    await expect(denyList.isDenied('jti-1')).resolves.toBe(true);
  });
});

describe('createMemoryTokenDenyList', () => {
  it('expires a denied jti when the token would have expired', async () => {
    let now = new Date('2026-10-18T12:00:00Z');
    const denyList = createMemoryTokenDenyList(() => now);
    await denyList.deny('jti-1', Date.parse('2026-10-18T12:05:00Z') / 1000);

    await expect(denyList.isDenied('jti-1')).resolves.toBe(true);

    now = new Date('2026-10-18T12:06:00Z');
    await expect(denyList.isDenied('jti-1')).resolves.toBe(false);
  });
});
