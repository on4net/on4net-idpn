import { MFA_ACR, MFA_AMR_METHODS, type MfaPolicy } from './mfa-types.js';

/**
 * True when the session proves a second factor: the documented ACR or an AMR entry for a
 * factor that was actually used (`docs/auth-flows.md` 7.3).
 */
export function sessionProvesMultiFactor(state: { amr: readonly string[]; acr: string }): boolean {
  if (state.acr === MFA_ACR) {
    return true;
  }
  return state.amr.some((method) => (MFA_AMR_METHODS as readonly string[]).includes(method));
}

/**
 * What a login must do about MFA once the password is verified.
 *
 * - `none` — no confirmed factor and the policy does not require one;
 * - `challenge` — a confirmed factor exists, so the session is only issued after a second
 *   factor (docs/auth-flows.md 7.3);
 * - `enrollment_required` — the client/login context requires MFA for this user but no
 *   factor is enrolled yet. No session is issued; the user must enroll first
 *   (`docs/roadmap.md` phase 4: an admin without MFA cannot sign in).
 */
export type MfaRequirement = 'none' | 'challenge' | 'enrollment_required';

export interface MfaRequirementInput {
  policy: MfaPolicy;
  /** A confirmed TOTP factor exists for the user. */
  hasConfirmedFactor: boolean;
  /** The user is an administrator in the sense of the `required_admins` policy. */
  isAdmin: boolean;
}

/**
 * Policy matrix. A confirmed factor always forces the challenge: an optional policy means
 * enrollment is the user's choice, not that an enrolled user may skip their second factor.
 */
export function mfaRequirement(input: MfaRequirementInput): MfaRequirement {
  if (input.hasConfirmedFactor) {
    return 'challenge';
  }
  if (input.policy === 'required_all') {
    return 'enrollment_required';
  }
  if (input.policy === 'required_admins' && input.isAdmin) {
    return 'enrollment_required';
  }
  return 'none';
}
