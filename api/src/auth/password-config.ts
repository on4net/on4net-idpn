import type { Argon2Params } from './password.js';

/** The subset of the validated server environment that controls password hashing. */
export interface Argon2Env {
  ARGON2_MEMORY_KIB: number;
  ARGON2_TIME_COST: number;
  ARGON2_PARALLELISM: number;
  PASSWORD_PEPPER?: string | undefined;
}

/**
 * Builds the hashing policy once at the composition root. Every hash/verify call site takes
 * these params, so raising the cost or adding a pepper applies to logins, resets, MFA
 * recovery codes and admin-created passwords alike (card #70 finding 4).
 */
export function argon2ParamsFromEnv(env: Argon2Env): Argon2Params {
  return {
    memoryCost: env.ARGON2_MEMORY_KIB,
    timeCost: env.ARGON2_TIME_COST,
    parallelism: env.ARGON2_PARALLELISM,
    ...(env.PASSWORD_PEPPER === undefined || env.PASSWORD_PEPPER === ''
      ? {}
      : { pepper: env.PASSWORD_PEPPER }),
  };
}
