import { describe, expect, it } from 'vitest';

import { validatePassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password-policy.js';

const subject = { email: 'Sara.Mohammadi@example.com', username: 'SMohammadi' };

describe('validatePassword', () => {
  it('accepts a long passphrase', () => {
    expect(validatePassword('correct horse battery staple', subject)).toEqual([]);
  });

  it(`rejects fewer than ${PASSWORD_MIN_LENGTH} characters`, () => {
    expect(validatePassword('short-pass1', subject)).toContain('too_short');
  });

  it(`rejects more than ${PASSWORD_MAX_LENGTH} characters`, () => {
    expect(validatePassword('a'.repeat(PASSWORD_MAX_LENGTH + 1), subject)).toContain('too_long');
  });

  it('counts length in code points, not UTF-16 units', () => {
    // 12 Persian characters are 12 code points but 24 UTF-16 units.
    expect(validatePassword('رمزعبورفارسیمن', subject)).not.toContain('too_short');
  });

  it('rejects common passwords case-insensitively', () => {
    expect(validatePassword('PasswordPassword', subject)).toContain('common_password');
    expect(validatePassword('QWERTY123456', subject)).toContain('common_password');
  });

  it('rejects a password containing the email or username', () => {
    expect(validatePassword('xxSara.Mohammadi@example.com', subject)).toContain(
      'contains_identity',
    );
    expect(validatePassword('smohammadi-2026!', subject)).toContain('contains_identity');
    expect(validatePassword('sara-2026-secure', subject)).toContain('contains_identity');
  });

  it('rejects leading or trailing whitespace', () => {
    expect(validatePassword(' spaced-password-1', subject)).toContain('contains_whitespace_edges');
  });

  it('reports every violation at once', () => {
    expect(validatePassword('short', {})).toEqual(['too_short']);
  });

  it('works without identity data', () => {
    expect(validatePassword('a-long-enough-passphrase', {})).toEqual([]);
  });
});
