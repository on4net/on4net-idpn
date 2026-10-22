import { FileSigningKeyRepository } from './file-key-repository.js';
import type { SigningKeyRepository } from './key-types.js';

/** The configuration the signing-key store depends on. */
export interface SigningKeyEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  SIGNING_KEY_REF?: string | undefined;
}

/** Development default: a git-ignored JSON file in the working directory. */
export const DEFAULT_SIGNING_KEY_FILE = '.idpn-keys.json';

const FILE_SCHEME = 'file://';

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
 * - any other scheme (`vault://`, `aws-kms://`, …) → startup failure, because the KMS adapter is
 *   not implemented yet. Silently falling back to a local file here is exactly the bug.
 */
export function createSigningKeyRepository(env: SigningKeyEnv): SigningKeyRepository {
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

  const scheme = ref.includes('://') ? ref.slice(0, ref.indexOf('://')) : ref;
  throw new Error(
    `SIGNING_KEY_REF scheme "${scheme}" is not supported yet: only file:// is implemented (KMS/Vault adapter pending)`,
  );
}
