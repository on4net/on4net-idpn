import { decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';

import { MemorySigningKeyRepository, SigningKeyManager } from './keys.js';

const issuer = 'https://auth.example.com';
const audience = 'app-a';

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
});
