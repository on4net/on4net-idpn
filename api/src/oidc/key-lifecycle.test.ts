import { decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';

import { generateSigningKey, MemorySigningKeyRepository, SigningKeyManager } from './keys.js';

const issuer = 'https://auth.example.com';
const audience = 'app-a';

/** Counts store reads so cache behavior is asserted instead of assumed. */
class CountingKeyRepository extends MemorySigningKeyRepository {
  listCalls = 0;

  override async list() {
    this.listCalls += 1;
    return super.list();
  }
}

const createManager = (options: {
  now: () => Date;
  retiredRetentionSeconds?: number;
  rotationDueAfterDays?: number;
}) =>
  new SigningKeyManager(new MemorySigningKeyRepository(), options.now, {
    retiredRetentionSeconds: options.retiredRetentionSeconds ?? 3600,
    rotationDueAfterDays: options.rotationDueAfterDays ?? 90,
  });

const sign = (manager: SigningKeyManager) =>
  manager.signAccessToken(
    { scope: 'openid' },
    { issuer, audience, subject: 'user-1', expiresInSeconds: 600 },
  );

describe('signing key lifecycle', () => {
  it('keeps a retired key in JWKS only until its tokens can no longer be valid', async () => {
    let now = new Date('2026-10-19T00:00:00Z');
    const manager = createManager({ now: () => now, retiredRetentionSeconds: 3600 });
    const first = await manager.ensureKey();
    const oldToken = await sign(manager);

    const rotated = await manager.rotate();
    expect(rotated.previousKid).toBe(first.kid);
    expect(rotated.previousRevoked).toBe(false);

    // Overlap: both keys are published and the old token still verifies.
    expect((await manager.jwks()).keys.map((key) => key.kid)).toEqual([
      first.kid,
      rotated.active.kid,
    ]);
    await expect(
      manager.verify(oldToken, { issuer, audience, currentDate: now }),
    ).resolves.toMatchObject({
      sub: 'user-1',
    });

    // Still inside the retention window.
    now = new Date('2026-10-19T00:59:59Z');
    expect((await manager.jwks()).keys).toHaveLength(2);

    // Once the window has elapsed the retired key is no longer published.
    now = new Date('2026-10-19T01:00:00Z');
    expect((await manager.jwks()).keys.map((key) => key.kid)).toEqual([rotated.active.kid]);
  });

  it('signs new tokens with the new kid after rotation', async () => {
    const manager = createManager({ now: () => new Date('2026-10-19T00:00:00Z') });
    const first = await manager.ensureKey();
    const rotated = await manager.rotate();

    const token = await sign(manager);
    expect(decodeProtectedHeader(token).kid).toBe(rotated.active.kid);
    expect(decodeProtectedHeader(token).kid).not.toBe(first.kid);
  });

  it('rejects tokens signed by a revoked key and drops it from JWKS', async () => {
    const manager = createManager({ now: () => new Date('2026-10-19T00:00:00Z') });
    const first = await manager.ensureKey();
    const oldToken = await sign(manager);
    const rotated = await manager.rotate();

    await expect(manager.revoke(first.kid)).resolves.toBe(true);

    expect((await manager.jwks()).keys.map((key) => key.kid)).toEqual([rotated.active.kid]);
    await expect(manager.verify(oldToken, { issuer, audience })).rejects.toThrow(/revoked/);
    expect(await manager.revoke('unknown-kid')).toBe(false);
  });

  it('revokes the previous key during an emergency rotation', async () => {
    const manager = createManager({ now: () => new Date('2026-10-19T00:00:00Z') });
    const first = await manager.ensureKey();
    const oldToken = await sign(manager);

    const rotated = await manager.rotate({ revokePrevious: true });
    expect(rotated.previousKid).toBe(first.kid);
    expect(rotated.previousRevoked).toBe(true);
    expect((await manager.jwks()).keys.map((key) => key.kid)).toEqual([rotated.active.kid]);
    await expect(manager.verify(oldToken, { issuer, audience })).rejects.toThrow(/revoked/);
  });

  it('provisions a new active key when the active key is revoked', async () => {
    const manager = createManager({ now: () => new Date('2026-10-19T00:00:00Z') });
    const first = await manager.ensureKey();
    const oldToken = await sign(manager);

    await expect(manager.revoke(first.kid)).resolves.toBe(true);

    const health = await manager.inspect();
    expect(health.activeKey?.kid).not.toBe(first.kid);
    expect(health.keys.find((key) => key.kid === first.kid)?.status).toBe('revoked');
    expect((await manager.jwks()).keys.map((key) => key.kid)).toEqual([health.activeKey?.kid]);
    await expect(manager.verify(oldToken, { issuer, audience })).rejects.toThrow(/revoked/);
  });

  it('reports rotation health without private material', async () => {
    let now = new Date('2026-10-19T00:00:00Z');
    const warnings: string[] = [];
    const manager = new SigningKeyManager(new MemorySigningKeyRepository(), () => now, {
      rotationDueAfterDays: 90,
      onWarning: (message) => warnings.push(message),
    });
    const active = await manager.ensureKey();

    const fresh = await manager.inspect();
    expect(fresh.rotationDue).toBe(false);
    expect(fresh.rotationDueAfterDays).toBe(90);
    expect(fresh.activeKey).toMatchObject({ kid: active.kid, ageDays: 0 });
    expect(fresh.keys[0]).toMatchObject({
      kid: active.kid,
      status: 'active',
      publishedInJwks: true,
    });
    expect(fresh.keys[0]?.createdAt).toBeInstanceOf(Date);
    expect(Object.keys(fresh.keys[0] ?? {}).sort()).toEqual([
      'alg',
      'createdAt',
      'kid',
      'publishedInJwks',
      'retiredAt',
      'status',
    ]);
    expect(JSON.stringify(fresh)).not.toContain('"d"');
    expect(warnings).toEqual([]);

    now = new Date('2027-01-17T00:00:00Z'); // exactly 90 days later
    const due = await manager.inspect();
    expect(due.rotationDue).toBe(true);
    expect(due.activeKey?.ageDays).toBe(90);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(active.kid);
  });

  it('serves repeated JWKS and verification requests without re-reading the key store', async () => {
    const repository = new CountingKeyRepository();
    const manager = new SigningKeyManager(repository, () => new Date('2026-10-19T00:00:00Z'));
    const active = await manager.ensureKey();
    const token = await sign(manager);
    const readsAfterSetup = repository.listCalls;

    for (let index = 0; index < 25; index += 1) {
      expect((await manager.jwks()).keys.map((key) => key.kid)).toEqual([active.kid]);
      await expect(
        manager.verify(token, {
          issuer,
          audience,
          currentDate: new Date('2026-10-19T00:00:00Z'),
        }),
      ).resolves.toMatchObject({ sub: 'user-1' });
    }

    // A cold cache reads once (plus the first `ensureKey`); 25 JWKS + 25 verifications
    // must not multiply that by the number of requests.
    expect(repository.listCalls).toBe(readsAfterSetup);
  });

  it('sees an out-of-process rotation after the cache TTL', async () => {
    let now = new Date('2026-10-19T00:00:00Z');
    const repository = new CountingKeyRepository();
    const manager = new SigningKeyManager(repository, () => now, { keyCacheTtlSeconds: 10 });
    const first = await manager.ensureKey();
    expect((await manager.jwks()).keys.map((key) => key.kid)).toEqual([first.kid]);

    // Another instance rotates: this manager's cache is intentionally stale until its TTL.
    await repository.updateStatus(first.kid, 'retired', now);
    const rotated = await generateSigningKey('active', now);
    await repository.save(rotated);
    expect((await manager.jwks()).keys.map((key) => key.kid)).toEqual([first.kid]);

    now = new Date(now.getTime() + 11_000);
    expect((await manager.jwks()).keys.map((key) => key.kid).sort()).toEqual(
      [first.kid, rotated.kid].sort(),
    );
  });

  it('provisions exactly one active key when a cold burst hits an empty store', async () => {
    const repository = new CountingKeyRepository();
    const manager = new SigningKeyManager(repository, () => new Date('2026-10-19T00:00:00Z'));

    const documents = await Promise.all(Array.from({ length: 20 }, () => manager.jwks()));

    expect(documents.every((document) => document.keys.length === 1)).toBe(true);
    expect(await repository.list()).toHaveLength(1);
  });

  it('invalidates the cache immediately on its own rotation and revocation', async () => {
    const repository = new CountingKeyRepository();
    const manager = new SigningKeyManager(repository, () => new Date('2026-10-19T00:00:00Z'));
    const first = await manager.ensureKey();
    await manager.jwks();

    const rotated = await manager.rotate();
    expect((await manager.jwks()).keys.map((key) => key.kid)).toEqual([
      first.kid,
      rotated.active.kid,
    ]);

    await manager.revoke(first.kid);
    expect((await manager.jwks()).keys.map((key) => key.kid)).toEqual([rotated.active.kid]);
  });
});
