/**
 * Account lockout policy shared by every credential check (password, TOTP, recovery code,
 * passkey). Keeping one policy means a second factor cannot be brute-forced after the
 * password budget was already spent, and a successful login always clears the counter.
 */

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

export interface LockoutState {
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export interface FailureState {
  attempts: number;
  lockedUntil: Date | null;
  locked: boolean;
}

export function isAccountLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}

/**
 * Next failure state for an account. An expired lock is a fresh window, so an attacker
 * cannot keep the account locked with a single attempt per window.
 */
export function nextFailureState(current: LockoutState, now: Date): FailureState {
  // Only an elapsed lock restarts the window; without a lock the counter simply continues.
  const lockExpired = current.lockedUntil !== null && !isAccountLocked(current.lockedUntil, now);
  const previous = lockExpired ? 0 : current.failedLoginCount;
  const attempts = previous + 1;
  const locked = attempts >= MAX_FAILED_ATTEMPTS;
  return {
    attempts,
    lockedUntil: locked ? new Date(now.getTime() + LOCK_DURATION_MS) : null,
    locked,
  };
}
