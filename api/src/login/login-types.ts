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
}

export interface LoginUserRepository {
  findByIdentifier(normalizedIdentifier: string): Promise<LoginUserRecord | null>;
  registerFailedAttempt(userId: string, attempts: number, lockedUntil: Date | null): Promise<void>;
  registerSuccessfulLogin(userId: string, at: Date): Promise<void>;
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
 */
export function sanitizeReturnTo(returnTo: string | undefined, appUrl: string): string | undefined {
  if (returnTo === undefined || returnTo.trim() === '') {
    return undefined;
  }
  const value = returnTo.trim();

  if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) {
    return value;
  }

  try {
    const candidate = new URL(value);
    const origin = new URL(appUrl).origin;
    return candidate.origin === origin ? candidate.toString() : undefined;
  } catch {
    return undefined;
  }
}
