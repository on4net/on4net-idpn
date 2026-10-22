import argon2 from 'argon2';

export interface Argon2Params {
  /** Memory cost in KiB (64 MiB by default, per docs/security.md 3.1). */
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  /** Optional server-side pepper (KMS-managed); never stored with the hash. */
  pepper?: string | undefined;
}

export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
};

/**
 * Hashes a password with Argon2id. A random 16-byte salt is generated per call by the
 * library and embedded in the PHC string, so equal passwords never share a hash.
 */
export async function hashPassword(
  password: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
    ...pepperOption(params),
  });
}

/** Verifies a password against a stored PHC string. Never throws for a bad password. */
export async function verifyPassword(
  hash: string,
  password: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password, pepperOption(params));
  } catch {
    // Malformed hash or wrong pepper must look like a failed authentication.
    return false;
  }
}

/** True when the stored hash uses weaker parameters than the current policy. */
export function needsRehash(hash: string, params: Argon2Params = DEFAULT_ARGON2_PARAMS): boolean {
  try {
    return argon2.needsRehash(hash, {
      memoryCost: params.memoryCost,
      timeCost: params.timeCost,
      parallelism: params.parallelism,
    });
  } catch {
    return true;
  }
}

function pepperOption(params: Argon2Params): { secret?: Buffer } {
  return params.pepper === undefined || params.pepper === ''
    ? {}
    : { secret: Buffer.from(params.pepper, 'utf8') };
}
