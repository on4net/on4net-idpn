import { describe, expect, it } from 'vitest';

import {
  CLIENT_SECRET_HASH_VERSION,
  ClientSecretConfigError,
  DEV_CLIENT_SECRET_PEPPER,
  DEV_CLIENT_SECRET_PEPPER_ID,
  createClientSecretService,
  defaultClientSecretService,
  hashClientSecret,
  loadClientSecretPeppers,
  verifyClientSecret,
  type ClientSecretPeppers,
} from './client-secret.js';
import { hashPassword, type Argon2Params } from './password.js';

// Cheap parameters keep the legacy-Argon2id cases fast; production uses DEFAULT_ARGON2_PARAMS.
const FAST: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const SECRET = 'Zq3tG6mN8vR1sT4uW7xY0aB2cD5eF9hJ';

const peppers: ClientSecretPeppers = {
  current: { id: 'k1', value: Buffer.from('unit-test-client-secret-pepper-value-1', 'utf8') },
  previous: [],
};

const rotated: ClientSecretPeppers = {
  current: { id: 'k2', value: Buffer.from('unit-test-client-secret-pepper-value-2', 'utf8') },
  previous: [{ id: 'k1', value: Buffer.from('unit-test-client-secret-pepper-value-1', 'utf8') }],
};

describe('hashClientSecret', () => {
  it('writes a versioned, pepper-tagged digest', () => {
    const hash = hashClientSecret(SECRET, peppers);

    expect(hash.startsWith(`${CLIENT_SECRET_HASH_VERSION}$k1$`)).toBe(true);
    expect(hash.split('$')).toHaveLength(3);
    // 32 HMAC bytes in unpadded base64url.
    expect(hash.split('$')[2]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).not.toContain(SECRET);
  });

  it('is deterministic so seeding and rehashing are idempotent', () => {
    expect(hashClientSecret(SECRET, peppers)).toBe(hashClientSecret(SECRET, peppers));
  });

  it('changes with the pepper', () => {
    expect(hashClientSecret(SECRET, peppers)).not.toBe(hashClientSecret(SECRET, rotated));
  });
});

describe('verifyClientSecret', () => {
  it('accepts the correct secret and rejects a wrong or empty one', async () => {
    const hash = hashClientSecret(SECRET, peppers);

    await expect(verifyClientSecret(SECRET, hash, peppers)).resolves.toEqual({
      valid: true,
      needsRehash: false,
    });
    await expect(verifyClientSecret(`${SECRET}x`, hash, peppers)).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
    await expect(verifyClientSecret('', hash, peppers)).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it('rejects a tampered digest without throwing', async () => {
    const [version, pepperId, digest] = hashClientSecret(SECRET, peppers).split('$');
    const flipped = `${digest?.slice(0, -1)}${digest?.endsWith('A') ? 'B' : 'A'}`;

    await expect(
      verifyClientSecret(SECRET, `${version}$${pepperId}$${flipped}`, peppers),
    ).resolves.toEqual({ valid: false, needsRehash: false });
  });

  it('fails closed on malformed or unknown formats', async () => {
    const valid = hashClientSecret(SECRET, peppers);
    const digest = valid.split('$')[2] ?? '';

    for (const stored of [
      'not-a-hash',
      '',
      `${CLIENT_SECRET_HASH_VERSION}$k1`,
      `${CLIENT_SECRET_HASH_VERSION}$k1$${digest}extra`,
      `${CLIENT_SECRET_HASH_VERSION}$k1$short`,
      `${CLIENT_SECRET_HASH_VERSION}$unknown$${digest}`,
      'v3$k1$abc',
      '$argon2i$v=19$m=8192,t=1,p=1$c2FsdA$aGFzaA',
    ]) {
      await expect(verifyClientSecret(SECRET, stored, peppers)).resolves.toEqual({
        valid: false,
        needsRehash: false,
      });
    }
  });

  it('still verifies legacy Argon2id hashes and flags them for rehash', async () => {
    const legacy = await hashPassword(SECRET, FAST);

    await expect(verifyClientSecret(SECRET, legacy, peppers)).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
    await expect(verifyClientSecret('wrong-secret', legacy, peppers)).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it('accepts a previous pepper during rotation and flags the hash for rehash', async () => {
    const withOldPepper = hashClientSecret(SECRET, peppers);

    await expect(verifyClientSecret(SECRET, withOldPepper, rotated)).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
  });
});

describe('createClientSecretService', () => {
  it('exposes the current pepper id and the same hash/verify behaviour', async () => {
    const service = createClientSecretService(peppers);

    expect(service.pepperId).toBe('k1');
    await expect(service.verify(SECRET, service.hash(SECRET))).resolves.toMatchObject({
      valid: true,
    });
  });
});

describe('loadClientSecretPeppers', () => {
  it('uses the labelled development pepper outside production', () => {
    const loaded = loadClientSecretPeppers({ NODE_ENV: 'development' });

    expect(loaded.current.id).toBe(DEV_CLIENT_SECRET_PEPPER_ID);
    expect(loaded.current.value.toString('utf8')).toBe(DEV_CLIENT_SECRET_PEPPER);
    expect(loaded.previous).toEqual([]);
  });

  it('refuses to start in production without a pepper', () => {
    expect(() => loadClientSecretPeppers({ NODE_ENV: 'production' })).toThrow(
      /CLIENT_SECRET_PEPPER is required in production/,
    );
  });

  it('loads the configured pepper and its public id', () => {
    const loaded = loadClientSecretPeppers({
      NODE_ENV: 'production',
      CLIENT_SECRET_PEPPER: 'production-client-secret-pepper-value',
      CLIENT_SECRET_PEPPER_ID: 'k7',
    });

    expect(loaded.current.id).toBe('k7');
    expect(loaded.current.value.toString('utf8')).toBe('production-client-secret-pepper-value');
  });

  it('rejects a short pepper, an invalid id and malformed rotation entries', () => {
    expect(() => loadClientSecretPeppers({ CLIENT_SECRET_PEPPER: 'too-short' })).toThrow(
      ClientSecretConfigError,
    );
    expect(() =>
      loadClientSecretPeppers({
        CLIENT_SECRET_PEPPER: 'production-client-secret-pepper-value',
        CLIENT_SECRET_PEPPER_ID: 'not a valid id',
      }),
    ).toThrow(/CLIENT_SECRET_PEPPER_ID/);
    expect(() =>
      loadClientSecretPeppers({
        CLIENT_SECRET_PEPPER: 'production-client-secret-pepper-value',
        CLIENT_SECRET_PREVIOUS_PEPPERS: 'k0',
      }),
    ).toThrow(/id:pepper/);
    expect(() =>
      loadClientSecretPeppers({
        CLIENT_SECRET_PEPPER: 'production-client-secret-pepper-value',
        CLIENT_SECRET_PREVIOUS_PEPPERS: 'k0:short',
      }),
    ).toThrow(/at least 32/);
    expect(() =>
      loadClientSecretPeppers({
        CLIENT_SECRET_PEPPER: 'production-client-secret-pepper-value',
        CLIENT_SECRET_PEPPER_ID: 'k1',
        CLIENT_SECRET_PREVIOUS_PEPPERS: 'k1:another-previous-pepper-value-32-chars',
      }),
    ).toThrow(/must not repeat the current/);
  });

  it('never echoes a pepper value in an error message', () => {
    const pepper = 'very-secret-pepper-value-that-must-not-leak';
    let caught: unknown;
    try {
      loadClientSecretPeppers({
        CLIENT_SECRET_PEPPER: 'current-client-secret-pepper-value-32',
        CLIENT_SECRET_PREVIOUS_PEPPERS: `k1:${pepper},k1:${pepper}`,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClientSecretConfigError);
    expect((caught as Error).message).not.toContain(pepper);
  });

  it('keeps previous peppers for verification only', async () => {
    const loaded = loadClientSecretPeppers({
      CLIENT_SECRET_PEPPER: 'current-client-secret-pepper-value-32',
      CLIENT_SECRET_PEPPER_ID: 'k2',
      CLIENT_SECRET_PREVIOUS_PEPPERS: 'k1:previous-client-secret-pepper-value-32',
    });
    const previous = loaded.previous[0];
    expect(previous).toBeDefined();
    const old = hashClientSecret(SECRET, {
      current: previous ?? loaded.current,
      previous: [],
    });

    await expect(verifyClientSecret(SECRET, old, loaded)).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
    expect(hashClientSecret(SECRET, loaded).startsWith('v2$k2$')).toBe(true);
  });
});

describe('defaultClientSecretService', () => {
  it('builds a service from the environment and caches it', () => {
    const env = {
      NODE_ENV: 'test',
      CLIENT_SECRET_PEPPER: 'default-service-client-secret-pepper-32',
      CLIENT_SECRET_PEPPER_ID: 'k3',
    };

    const first = defaultClientSecretService(env);
    expect(first.pepperId).toBe('k3');
    expect(defaultClientSecretService(env)).toBe(first);
    expect(first.hash(SECRET).startsWith('v2$k3$')).toBe(true);
  });
});
