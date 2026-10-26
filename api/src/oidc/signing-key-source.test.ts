import { describe, expect, it } from 'vitest';

import { createKeyringSecretBox } from '../crypto/secret-box.js';
import { FileSigningKeyRepository } from './file-key-repository.js';
import { createSigningKeyRepository, DEFAULT_SIGNING_KEY_FILE } from './signing-key-source.js';

describe('createSigningKeyRepository', () => {
  it('falls back to the development file store outside production', () => {
    const repository = createSigningKeyRepository({ NODE_ENV: 'development' });

    expect(repository).toBeInstanceOf(FileSigningKeyRepository);
    expect((repository as unknown as { filePath: string }).filePath).toBe(DEFAULT_SIGNING_KEY_FILE);
  });

  it('refuses to start in production without a reference', () => {
    expect(() => createSigningKeyRepository({ NODE_ENV: 'production' })).toThrow(
      /SIGNING_KEY_REF is required in production/,
    );
  });

  it('honours a file:// reference in production', () => {
    const repository = createSigningKeyRepository({
      NODE_ENV: 'production',
      SIGNING_KEY_REF: 'file:///var/lib/idpn/signing-keys.json',
    });

    expect((repository as unknown as { filePath: string }).filePath).toBe(
      '/var/lib/idpn/signing-keys.json',
    );
  });

  it('rejects a file:// reference without a path', () => {
    expect(() =>
      createSigningKeyRepository({ NODE_ENV: 'production', SIGNING_KEY_REF: 'file://' }),
    ).toThrow(/must name a path/);
  });

  it('fails closed for a KMS/Vault reference instead of writing a local key file', () => {
    expect(() =>
      createSigningKeyRepository({
        NODE_ENV: 'production',
        SIGNING_KEY_REF: 'vault://idpn/signing',
      }),
    ).toThrow(/scheme "vault" is not supported/);

    expect(() =>
      createSigningKeyRepository({ NODE_ENV: 'production', SIGNING_KEY_REF: 'CHANGE_ME' }),
    ).toThrow(/scheme "CHANGE_ME" is not supported/);
  });

  it('builds the shared database store only with a connection and a wrap key', () => {
    const env = { NODE_ENV: 'production', SIGNING_KEY_REF: 'db://signing_keys' } as const;
    expect(() => createSigningKeyRepository(env)).toThrow(/needs the database connection/);
    expect(() => createSigningKeyRepository(env, { prisma: {} as never, wrapBox: null })).toThrow(
      /requires SIGNING_KEY_WRAP_KEY/,
    );
    const box = createKeyringSecretBox({
      current: { id: 1, key: Buffer.alloc(32, 3) },
      previous: [],
    });
    expect(createSigningKeyRepository(env, { prisma: {} as never, wrapBox: box })).toBeDefined();
  });
});
