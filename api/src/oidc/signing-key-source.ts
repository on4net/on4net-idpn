import type { KeyringSecretBox } from '../crypto/secret-box.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { FileSigningKeyRepository } from './file-key-repository.js';
import type { SigningKeyRepository } from './key-types.js';
import { createPrismaSigningKeyRepository } from './prisma-key-repository.js';

/** The configuration the signing-key store depends on. */
export interface SigningKeyEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  SIGNING_KEY_REF?: string | undefined;
}

/** Development default: a git-ignored JSON file in the working directory. */
export const DEFAULT_SIGNING_KEY_FILE = '.idpn-keys.json';

const FILE_SCHEME = 'file://';
const DB_SCHEME = 'db://';

/** What the `db://` store needs; supplied by the composition root. */
export interface SigningKeyStoreDependencies {
  prisma?: PrismaClient;
  /** Envelope box built from `SIGNING_KEY_WRAP_KEY`; its key comes from KMS/Vault. */
  wrapBox?: KeyringSecretBox | null;
}

/**
 * Resolves the signing-key store from `SIGNING_KEY_REF` (card #70 finding 6).
 *
 * A per-replica key file is a correctness *and* a security problem: a token signed by one
 * replica is rejected by the next, and the private key ends up on a local disk. So the
 * resolution fails closed instead of silently defaulting:
 *
 * - unset outside production → the development file store;
 * - unset in production → startup failure (the env schema already rejects this);
 * - `file://<path>` → the file store at that path (single replica or a shared volume only);
 * - `db://signing_keys` → PostgreSQL, shared by all replicas, private keys envelope-encrypted
 *   under `SIGNING_KEY_WRAP_KEY` (supplied by KMS/Vault);
 * - any other scheme (`vault://`, `aws-kms://`, …) → startup failure, because no native adapter
 *   exists. Silently falling back to a local file here is exactly the bug.
 */
export function createSigningKeyRepository(
  env: SigningKeyEnv,
  dependencies: SigningKeyStoreDependencies = {},
): SigningKeyRepository {
  const ref = env.SIGNING_KEY_REF;

  if (ref === undefined) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'SIGNING_KEY_REF is required in production: set a file:// path on a shared volume, or wire a KMS/Vault adapter',
      );
    }
    return new FileSigningKeyRepository(DEFAULT_SIGNING_KEY_FILE);
  }

  if (ref.startsWith(FILE_SCHEME)) {
    const path = ref.slice(FILE_SCHEME.length);
    if (path === '') {
      throw new Error('SIGNING_KEY_REF must name a path after file://');
    }
    return new FileSigningKeyRepository(path);
  }

  if (ref.startsWith(DB_SCHEME)) {
    if (dependencies.prisma === undefined) {
      throw new Error('SIGNING_KEY_REF db:// needs the database connection');
    }
    if (dependencies.wrapBox === undefined || dependencies.wrapBox === null) {
      throw new Error(
        'SIGNING_KEY_REF db:// requires SIGNING_KEY_WRAP_KEY (inject it from KMS/Vault): ' +
          'private signing keys are never stored unencrypted',
      );
    }
    return createPrismaSigningKeyRepository(dependencies.prisma, dependencies.wrapBox);
  }

  const scheme = ref.includes('://') ? ref.slice(0, ref.indexOf('://')) : ref;
  throw new Error(
    `SIGNING_KEY_REF scheme "${scheme}" is not supported: use file:// (single replica / shared volume) or db:// (shared, envelope-encrypted)`,
  );
}
