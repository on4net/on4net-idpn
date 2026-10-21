import { verifyPassword, type Argon2Params, DEFAULT_ARGON2_PARAMS } from './password.js';

export type UserStatus = 'active' | 'locked' | 'disabled' | 'pending';

export interface AuthenticatableUser {
  id: string;
  status: UserStatus;
  passwordHash: string | null;
  lockedUntil: Date | null;
  deletedAt: Date | null;
}

export type AuthenticationFailure =
  'invalid_credentials' | 'no_password' | 'user_disabled' | 'user_locked' | 'user_deleted';

export type AuthenticationResult =
  { ok: true; userId: string } | { ok: false; reason: AuthenticationFailure };

export interface AuthenticateOptions {
  params?: Argon2Params;
  now?: () => Date;
}

/**
 * Authenticates a user against a password hash.
 *
 * The returned reason is for internal decisions (audit, lock counters); callers must not
 * expose it to the client — every failure is presented as `invalid_credentials`.
 */
export async function authenticateWithPassword(
  user: AuthenticatableUser,
  password: string,
  options: AuthenticateOptions = {},
): Promise<AuthenticationResult> {
  const now = options.now?.() ?? new Date();

  if (user.deletedAt !== null) {
    return { ok: false, reason: 'user_deleted' };
  }
  if (user.status === 'disabled') {
    return { ok: false, reason: 'user_disabled' };
  }
  if (isLocked(user, now)) {
    return { ok: false, reason: 'user_locked' };
  }
  if (user.passwordHash === null || user.passwordHash === '') {
    return { ok: false, reason: 'no_password' };
  }

  const valid = await verifyPassword(
    user.passwordHash,
    password,
    options.params ?? DEFAULT_ARGON2_PARAMS,
  );

  // A pending user may prove the password (e.g. to finish verification) but must not be
  // treated as fully authenticated by callers that require an active account.
  if (!valid) {
    return { ok: false, reason: 'invalid_credentials' };
  }
  return { ok: true, userId: user.id };
}

/**
 * Whether the account is locked right now.
 *
 * `lockedUntil` is honoured whether or not `status` was flipped, so a lock created by failed
 * attempts expires on its own (`docs/security.md` 3.2: 15 minutes, escalating). A manual
 * `status = 'locked'` without an expiry stays permanent until an administrator unlocks it.
 */
export function isLocked(user: AuthenticatableUser, now: Date = new Date()): boolean {
  if (user.lockedUntil !== null) {
    return user.lockedUntil.getTime() > now.getTime();
  }
  return user.status === 'locked';
}
