import { normalizeEmail, normalizeUsername } from '../auth/normalize.js';

/**
 * Resolves a user by email or username. Both are stored lowercase
 * (docs/domain-model.md 2.2), so the identifier is normalized before lookup.
 */
export interface LoginUserRecord {
  id: string;
  tenantId: string;
  username: string;
  email: string;
  displayName: string;
  locale: string;
  status: 'active' | 'locked' | 'disabled' | 'pending';
  passwordHash: string | null;
  lockedUntil: Date | null;
  failedLoginCount: number;
  deletedAt: Date | null;
  /**
   * Whether a confirmed second factor exists. The route needs it to fail closed when the
   * deployment has no MFA repository wired instead of silently issuing a password-only
   * session (card #38 review, finding 6).
   */
  hasConfirmedFactor: boolean;
}

export interface LoginUserRepository {
  findByIdentifier(normalizedIdentifier: string): Promise<LoginUserRecord | null>;
  registerFailedAttempt(userId: string, attempts: number, lockedUntil: Date | null): Promise<void>;
  registerSuccessfulLogin(userId: string, at: Date): Promise<void>;
  /** Stores a hash produced with the current policy after a successful login (card #70). */
  rehashPassword?(userId: string, passwordHash: string): Promise<void>;
}

export interface LoginRequestInput {
  identifier: string;
  password: string;
  clientId?: string;
  returnTo?: string;
}

export type LoginFailure = 'invalid_credentials';

export const LOGIN_FAILED_MESSAGE = 'نام کاربری یا رمز عبور نادرست است.';
export const LOGIN_FAILED_CODE = 'invalid_credentials';

/** Normalizes an identifier that may be an email or a username. */
export function normalizeIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  return trimmed.includes('@') ? normalizeEmail(trimmed) : normalizeUsername(trimmed);
}

/**
 * Only same-origin relative paths or URLs on the IdP origin are accepted as a post-login
 * redirect. Anything else (protocol-relative, `javascript:`, foreign hosts) is rejected so
 * the login page cannot be used as an open redirector.
 *
 * Control characters and backslashes are rejected outright: a browser normalises `\\` to `/`
 * and strips tabs/newlines, so `/<TAB>/evil.example` or `/\evil.example` would be read as
 * `//evil.example` by the location parser while passing a prefix check.
 */
/** Control characters and backslashes are normalised by the URL parser, e.g. `/<TAB>/host`. */
const hasUnsafeRedirectCharacter = (value: string): boolean =>
  value.includes('\\') ||
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

export function sanitizeReturnTo(returnTo: string | undefined, appUrl: string): string | undefined {
  if (returnTo === undefined || returnTo.trim() === '') {
    return undefined;
  }
  const value = returnTo.trim();
  if (hasUnsafeRedirectCharacter(value)) {
    return undefined;
  }

  try {
    const origin = new URL(appUrl).origin;
    const resolved = new URL(value, origin);
    if (resolved.origin !== origin) {
      return undefined;
    }
    return value.startsWith('/')
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : resolved.toString();
  } catch {
    return undefined;
  }
}
