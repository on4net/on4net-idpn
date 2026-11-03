import argon2 from 'argon2';

export interface Argon2Params {
  /** Memory cost in KiB (64 MiB by default, per docs/security.md 3.1). */
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  /** Optional server-side pepper (KMS-managed); never stored with the hash. */
  pepper?: string | undefined;
  /**
   * Peppers that were current before a rotation. A hash that only verifies under one of these
   * (or, when `acceptUnpeppered` is set, with no pepper at all) is still accepted and is then
   * rewritten under the current pepper by the next successful login (`needsPepperUpgrade`).
   */
  previousPeppers?: readonly string[] | undefined;
  /** Accept hashes created before any pepper existed; used while enabling the first pepper. */
  acceptUnpeppered?: boolean | undefined;
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
    if (await argon2.verify(hash, password, pepperOption(params))) {
      return true;
    }
  } catch {
    // Malformed hash or wrong pepper must look like a failed authentication.
    return false;
  }
  for (const candidate of fallbackPeppers(params)) {
    try {
      if (await argon2.verify(hash, password, candidate)) {
        return true;
      }
    } catch {
      // Same: a failed candidate is simply not the right pepper.
    }
  }
  return false;
}

/**
 * True when a hash that just verified is not under the current pepper, so the caller can
 * rewrite it. Costs one extra verification, and only while a rotation window is configured.
 */
export async function needsPepperUpgrade(
  hash: string,
  password: string,
  params: Argon2Params,
): Promise<boolean> {
  if (fallbackPeppers(params).length === 0) {
    return false;
  }
  try {
    return !(await argon2.verify(hash, password, pepperOption(params)));
  } catch {
    return true;
  }
}

function fallbackPeppers(params: Argon2Params): Array<{ secret?: Buffer }> {
  const candidates: Array<{ secret?: Buffer }> = [];
  for (const previous of params.previousPeppers ?? []) {
    if (previous !== '' && previous !== params.pepper) {
      candidates.push({ secret: Buffer.from(previous, 'utf8') });
    }
  }
  if (params.acceptUnpeppered === true && params.pepper !== undefined && params.pepper !== '') {
    candidates.push({});
  }
  return candidates;
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
