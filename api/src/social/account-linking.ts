import type { SocialAdapterErrorCode } from './types.js';

/**
 * Public social error codes (`docs/auth-flows.md` 9.5). These are the only values ever put in
 * a redirect or a log line; adapter messages and provider bodies are never forwarded.
 */
export type SocialErrorCode =
  | 'social_provider_disabled'
  | 'social_state_invalid'
  | 'social_email_unverified'
  | 'social_account_conflict'
  | 'social_provider_error'
  | 'social_membership_suspended'
  | 'access_denied';

/** Maps an adapter failure to the public code; unknown providers share the generic code. */
export function adapterErrorToSocialError(code: SocialAdapterErrorCode): SocialErrorCode {
  switch (code) {
    case 'email_unverified':
      return 'social_email_unverified';
    case 'invalid_grant':
    case 'provider_unavailable':
    case 'invalid_response':
      return 'social_provider_error';
  }
}

export type RegistrationPolicy = 'invite_only' | 'self_service' | 'disabled';

export interface RegistrationPolicyInput {
  registrationPolicy: RegistrationPolicy;
  /** Client-wide allowlist (`Client.allowed_email_domains`). */
  clientEmailDomains: readonly string[];
  /** Provider-specific allowlist (`ClientSocialProvider.allowed_email_domains`). */
  providerEmailDomains: readonly string[];
  email: string | null;
}

/**
 * Decides whether a social login may create a user / membership for this app
 * (`docs/auth-flows.md` 8.7, 9.3).
 *
 * - `disabled` never allows self-service.
 * - `self_service` always allows it.
 * - `invite_only` still admits an address on the client or provider allowlist, which is the
 *   documented alternative to an invitation.
 */
export function registrationAllowed(input: RegistrationPolicyInput): boolean {
  if (input.registrationPolicy === 'disabled') {
    return false;
  }
  if (input.registrationPolicy === 'self_service') {
    return true;
  }
  if (input.email === null) {
    return false;
  }
  return emailDomainAllowed(input.email, [
    ...input.clientEmailDomains,
    ...input.providerEmailDomains,
  ]);
}

/** Case-insensitive exact domain match; leading `@` is tolerated in stored values. */
export function emailDomainAllowed(email: string, domains: readonly string[]): boolean {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) {
    return false;
  }
  const domain = email.slice(at + 1).toLowerCase();
  return domains.some((entry) => {
    const normalized = entry.trim().toLowerCase().replace(/^@/, '');
    return normalized !== '' && normalized === domain;
  });
}

/** Only active, non-deleted users may receive a session. */
export function userCanSignIn(user: {
  status: 'active' | 'locked' | 'disabled' | 'pending';
  deletedAt: Date | null;
}): boolean {
  return user.deletedAt === null && user.status === 'active';
}
