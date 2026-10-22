import { describe, expect, it } from 'vitest';

import { FileSigningKeyRepository } from './file-key-repository.js';
import { createSigningKeyRepository, DEFAULT_SIGNING_KEY_FILE } from './signing-key-source.js';

describe('createSigningKeyRepository', () => {
  it('falls back to the development file store outside production', () => {
    const repository = createSigningKeyRepository({ NODE_ENV: 'development' });

    expect(repository).toBeInstanceOf(FileSigningKeyRepository);
    expect((repository as unknown as { filePath: string }).filePath).toBe(
      DEFAULT_SIGNING_KEY_FILE,
    );
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
    ).toThrow(/scheme "vault" is not supported yet/);

    expect(() =>
      createSigningKeyRepository({ NODE_ENV: 'production', SIGNING_KEY_REF: 'CHANGE_ME' }),
    ).toThrow(/scheme "CHANGE_ME" is not supported yet/);
  });
});
