import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileSigningKeyRepository } from './file-key-repository.js';
import { SigningKeyManager } from './keys.js';

let directory: string;
let repository: FileSigningKeyRepository;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'idpn-keys-'));
  repository = new FileSigningKeyRepository(join(directory, 'keys.json'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('FileSigningKeyRepository', () => {
  it('starts empty and persists a key across manager instances', async () => {
    const first = new SigningKeyManager(repository);
    const created = await first.ensureKey();

    const second = new SigningKeyManager(repository);
    const reloaded = await second.ensureKey();

    expect(reloaded.kid).toBe(created.kid);
    expect(await repository.list()).toHaveLength(1);
  });

  it('persists rotation state (active + retired)', async () => {
    const manager = new SigningKeyManager(repository);
    const first = await manager.ensureKey();
    const second = await manager.rotate();

    const keys = await repository.list();
    expect(keys).toHaveLength(2);
    expect(keys.find((key) => key.kid === first.kid)?.status).toBe('retired');
    expect(keys.find((key) => key.kid === second.active.kid)?.status).toBe('active');
    expect(keys.find((key) => key.kid === first.kid)?.retiredAt).toBeInstanceOf(Date);
  });

  it('ignores an unknown kid when updating status', async () => {
    await expect(repository.updateStatus('missing', 'retired')).resolves.toBeUndefined();
    expect(await repository.list()).toEqual([]);
  });

  it('keeps every key when saves run concurrently and leaves no temporary file', async () => {
    const source = new SigningKeyManager(
      new FileSigningKeyRepository(join(directory, 'seed.json')),
    );
    const seed = await source.ensureKey();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repository.save({ ...seed, kid: `kid-${String(index)}` }),
      ),
    );
    expect(await repository.list()).toHaveLength(8);
    const files = await readdir(directory);
    expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('SigningKeyManager retention', () => {
  it('refuses a retention shorter than the longest access-token lifetime', () => {
    expect(
      () => new SigningKeyManager(repository, undefined, { retiredRetentionSeconds: 600 }),
    ).toThrow(/at least 3600/);
  });
});
