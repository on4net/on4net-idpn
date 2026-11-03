import { describe, expect, it } from 'vitest';

import type { StoredSigningKey } from './key-types.js';
import { MemorySigningKeyRepository, SigningKeyConflictError, SigningKeyManager } from './keys.js';

/** Behaves like the Prisma store: the partial unique index rejects a second active key. */
class SingleActiveRepository extends MemorySigningKeyRepository {
  override async save(key: StoredSigningKey): Promise<void> {
    // Yield first so both "replicas" read before either writes.
    await Promise.resolve();
    const keys = await this.list();
    if (key.status === 'active' && keys.some((k) => k.status === 'active' && k.kid !== key.kid)) {
      throw new SigningKeyConflictError();
    }
    await super.save(key);
  }
}

const now = () => new Date('2026-10-28T00:00:00Z');
const manager = (repository: SingleActiveRepository) =>
  new SigningKeyManager(repository, now, {
    retiredRetentionSeconds: 3600,
    rotationDueAfterDays: 90,
    rotationCooldownSeconds: 0,
  });

describe('single active key under concurrency (#75)', () => {
  it('two cold-starting replicas end up using the same key', async () => {
    const repository = new SingleActiveRepository();
    const [a, b] = await Promise.all([
      manager(repository).ensureKey(),
      manager(repository).ensureKey(),
    ]);
    expect(a.kid).toBe(b.kid);
    expect((await repository.list()).filter((key) => key.status === 'active')).toHaveLength(1);
  });

  it('a rotation that loses the race fails with a conflict and leaves one active key', async () => {
    const repository = new SingleActiveRepository();
    await manager(repository).ensureKey();
    const results = await Promise.allSettled([
      manager(repository).rotate(),
      manager(repository).rotate(),
    ]);
    const lost = results.filter((r) => r.status === 'rejected');
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(SigningKeyConflictError);
    expect((await repository.list()).filter((key) => key.status === 'active')).toHaveLength(1);
  });
});
