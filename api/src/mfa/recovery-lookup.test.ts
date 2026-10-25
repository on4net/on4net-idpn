import { describe, expect, it } from 'vitest';

import {
  createRecoveryLookup,
  DEV_RECOVERY_LOOKUP_KEY_ID,
  loadRecoveryLookupKeys,
  RecoveryLookupConfigError,
} from './recovery-lookup.js';

const KEY_ONE = 'unit-test-recovery-lookup-key-one-0123456789';
const KEY_TWO = 'unit-test-recovery-lookup-key-two-0123456789';

describe('recovery lookup values', () => {
  const lookup = createRecoveryLookup({
    current: { id: 'k2', value: Buffer.from(KEY_TWO) },
    previous: [{ id: 'k1', value: Buffer.from(KEY_ONE) }],
  });

  it('is deterministic, tagged with the key id and not the plain code', () => {
    const value = lookup.create('ABCDEFGHJK');
    expect(value).toBe(lookup.create('ABCDEFGHJK'));
    expect(value.startsWith('k2$')).toBe(true);
    expect(value).not.toContain('ABCDEFGHJK');
    expect(value.split('$')[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('differs per code and per key', () => {
    expect(lookup.create('ABCDEFGHJK')).not.toBe(lookup.create('ABCDEFGHJL'));
    const [current, previous] = lookup.candidates('ABCDEFGHJK');
    expect(current).toBe(lookup.create('ABCDEFGHJK'));
    expect(previous?.startsWith('k1$')).toBe(true);
    expect(previous).not.toBe(current);
  });
});

describe('loadRecoveryLookupKeys', () => {
  it('uses a public development key outside production', () => {
    const keys = loadRecoveryLookupKeys({ NODE_ENV: 'test' });
    expect(keys.current.id).toBe(DEV_RECOVERY_LOOKUP_KEY_ID);
    expect(keys.previous).toEqual([]);
  });

  it('fails closed in production without a key', () => {
    expect(() => loadRecoveryLookupKeys({ NODE_ENV: 'production' })).toThrow(
      RecoveryLookupConfigError,
    );
  });

  it('reads the current and previous keys and rejects weak or repeated ones', () => {
    const keys = loadRecoveryLookupKeys({
      NODE_ENV: 'production',
      RECOVERY_LOOKUP_KEY: KEY_TWO,
      RECOVERY_LOOKUP_KEY_ID: 'k2',
      RECOVERY_LOOKUP_PREVIOUS_KEYS: `k1:${KEY_ONE}`,
    });
    expect(keys.current.id).toBe('k2');
    expect(keys.previous.map((key) => key.id)).toEqual(['k1']);

    expect(() => loadRecoveryLookupKeys({ RECOVERY_LOOKUP_KEY: 'short' })).toThrow(/at least 32/);
    expect(() =>
      loadRecoveryLookupKeys({
        RECOVERY_LOOKUP_KEY: KEY_TWO,
        RECOVERY_LOOKUP_KEY_ID: 'k1',
        RECOVERY_LOOKUP_PREVIOUS_KEYS: `k1:${KEY_ONE}`,
      }),
    ).toThrow(/repeat a key id/);
    expect(() =>
      loadRecoveryLookupKeys({
        RECOVERY_LOOKUP_KEY: KEY_TWO,
        RECOVERY_LOOKUP_PREVIOUS_KEYS: 'nokey',
      }),
    ).toThrow(/id:key pairs/);
  });
});
