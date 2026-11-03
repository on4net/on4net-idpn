import { describe, expect, it } from 'vitest';

import { KeyRotationScheduler } from './key-rotation-scheduler.js';
import { MemorySigningKeyRepository, SigningKeyManager } from './keys.js';

const createManager = (now: () => Date) =>
  new SigningKeyManager(new MemorySigningKeyRepository(), now, { rotationDueAfterDays: 90 });

describe('KeyRotationScheduler', () => {
  it('never starts or rotates in a test build', async () => {
    const manager = createManager(() => new Date('2027-01-01T00:00:00Z'));
    await manager.ensureKey();
    const scheduler = new KeyRotationScheduler({
      keys: manager,
      intervalDays: 90,
      nodeEnv: 'test',
    });

    expect(scheduler.isEnabled).toBe(false);
    scheduler.start();
    await expect(scheduler.tick()).resolves.toBeNull();
    expect((await manager.inspect()).keys).toHaveLength(1);
  });

  it('does nothing when the configured interval is 0', async () => {
    const manager = createManager(() => new Date('2026-10-19T00:00:00Z'));
    await manager.ensureKey();
    const scheduler = new KeyRotationScheduler({
      keys: manager,
      intervalDays: 0,
      nodeEnv: 'production',
    });

    expect(scheduler.isEnabled).toBe(false);
    await expect(scheduler.tick()).resolves.toBeNull();
  });

  it('rotates once the active key reaches the interval and reports it', async () => {
    let now = new Date('2026-10-19T00:00:00Z');
    const manager = createManager(() => now);
    const first = await manager.ensureKey();
    const rotations: string[] = [];
    const scheduler = new KeyRotationScheduler({
      keys: manager,
      intervalDays: 90,
      nodeEnv: 'production',
      onRotated: (result) => {
        rotations.push(result.active.kid);
      },
    });

    await expect(scheduler.tick()).resolves.toBeNull();
    expect(rotations).toEqual([]);

    now = new Date('2027-01-17T00:00:00Z'); // 90 days
    const result = await scheduler.tick();
    expect(result?.previousKid).toBe(first.kid);
    expect(rotations).toEqual([result?.active.kid]);
    expect((await manager.jwks()).keys).toHaveLength(2);

    // The new key is fresh, so the next check is a no-op.
    await expect(scheduler.tick()).resolves.toBeNull();
    expect(rotations).toHaveLength(1);
    scheduler.stop();
  });

  it('surfaces rotation failures to the caller of tick', async () => {
    let now = new Date('2026-10-19T00:00:00Z');
    const manager = createManager(() => now);
    await manager.ensureKey();
    now = new Date('2027-01-17T00:00:00Z');
    manager.rotate = async () => {
      throw new Error('kms unavailable');
    };
    const scheduler = new KeyRotationScheduler({
      keys: manager,
      intervalDays: 90,
      nodeEnv: 'production',
    });

    await expect(scheduler.tick()).rejects.toThrow('kms unavailable');
  });
});
