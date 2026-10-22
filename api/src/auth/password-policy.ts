/** Minimum and maximum password length (docs/security.md 3.1). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Small embedded blocklist of the passwords that dominate breach corpora.
 * A HIBP k-anonymity check can be layered on top later without changing this API.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  [
    '123456789012',
    '1234567890123',
    '12345678901234',
    'password1234',
    'passwordpassword',
    'passw0rd1234',
    'qwertyuiopas',
    'qwerty123456',
    'letmein12345',
    'welcome12345',
    'admin1234567',
    'administrator',
    'iloveyou1234',
    'monkey123456',
    'dragon123456',
    'football1234',
    'baseball1234',
    'superman1234',
    'trustno1trustno1',
    'changeme1234',
    'sunshine1234',
    'princess1234',
    'shadow123456',
    'michael12345',
    'master123456',
    'whatever1234',
    'freedom12345',
    'abc123456789',
    'aaaaaaaaaaaa',
    '000000000000',
    '111111111111',
    '1qaz2wsx3edc',
    'qazwsxedcrfv',
    'zaq12wsxcde3',
    'password!234',
    'p@ssw0rd1234',
    'on4neton4net',
  ].map((password) => password.toLowerCase()),
);

export interface PasswordSubject {
  email?: string | undefined;
  username?: string | undefined;
  displayName?: string | undefined;
}

export type PasswordPolicyViolation =
  'too_short' | 'too_long' | 'common_password' | 'contains_identity' | 'contains_whitespace_edges';

export const PASSWORD_POLICY_MESSAGES: Record<PasswordPolicyViolation, string> = {
  too_short: `رمز عبور باید حداقل ${PASSWORD_MIN_LENGTH} کاراکتر باشد.`,
  too_long: `رمز عبور نباید بیشتر از ${PASSWORD_MAX_LENGTH} کاراکتر باشد.`,
  common_password: 'این رمز عبور رایج است؛ رمز دیگری انتخاب کنید.',
  contains_identity: 'رمز عبور نباید شامل ایمیل یا نام کاربری شما باشد.',
  contains_whitespace_edges: 'رمز عبور نباید با فاصله شروع یا پایان یابد.',
};

/**
 * Validates a password against the policy in docs/security.md 3.1.
 * Length is counted in Unicode code points, not UTF-16 units.
 */
export function validatePassword(
  password: string,
  subject: PasswordSubject = {},
  commonPasswords: ReadonlySet<string> = COMMON_PASSWORDS,
): PasswordPolicyViolation[] {
  const violations: PasswordPolicyViolation[] = [];
  const length = Array.from(password).length;

  if (length < PASSWORD_MIN_LENGTH) {
    violations.push('too_short');
  }
  if (length > PASSWORD_MAX_LENGTH) {
    violations.push('too_long');
  }
  if (password !== password.trim()) {
    violations.push('contains_whitespace_edges');
  }

  const normalized = password.toLowerCase();
  if (commonPasswords.has(normalized)) {
    violations.push('common_password');
  }
  if (containsIdentity(normalized, subject)) {
    violations.push('contains_identity');
  }

  return violations;
}

function containsIdentity(normalizedPassword: string, subject: PasswordSubject): boolean {
  const candidates = [subject.email, subject.username, subject.displayName]
    .flatMap((value) => (value === undefined || value === '' ? [] : [value.toLowerCase()]))
    .flatMap((value) => {
      const localPart = value.split('@')[0] ?? '';
      const tokens = localPart.split(/[._+-]/).filter((token) => token.length >= 4);
      return [value, localPart, ...tokens];
    })
    .map((value) => value.replace(/\s+/g, ''))
    .filter((value) => value.length >= 3);

  return candidates.some((candidate) => normalizedPassword.includes(candidate));
}
