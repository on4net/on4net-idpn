import { describe, expect, it } from 'vitest';

import {
  BASE_MESSAGE_KEYS,
  bracesBalanced,
  isSafeStoredMessage,
  localeSettingsProblems,
  MAX_MESSAGE_LENGTH,
  placeholderNames,
  validateMessages,
} from './translation-validation.js';

describe('localeSettingsProblems', () => {
  it('accepts a complete locale set', () => {
    expect(
      localeSettingsProblems({
        default: 'fa-IR',
        supported: ['fa-IR', 'en-US'],
        calendar: 'persian',
      }),
    ).toEqual([]);
  });

  it('requires a non-empty supported list and a default inside it', () => {
    expect(localeSettingsProblems({ default: 'fa-IR', supported: [] })).toContain(
      'supported: at least one locale is required',
    );
    expect(localeSettingsProblems({ default: 'de-DE', supported: ['fa-IR', 'en-US'] })).toContain(
      'default: must be one of the supported locales',
    );
  });

  it('rejects malformed tags, duplicates and unknown calendars', () => {
    const problems = localeSettingsProblems({
      default: 'fa IR',
      supported: ['fa-IR', 'fa-ir', 'not_a_locale!'],
      calendar: 'islamic',
    });
    expect(problems.some((problem) => problem.startsWith('default:'))).toBe(true);
    expect(problems).toContain('supported[1]: duplicate locale fa-IR');
    expect(problems).toContain('supported[2]: must be a BCP-47 locale code');
    expect(problems).toContain('calendar: must be one of gregorian, persian');
  });

  it('caps the supported locale count', () => {
    const supported = Array.from({ length: 21 }, (_, index) => `l${index}-IR`);
    expect(localeSettingsProblems({ default: 'l0-IR', supported })).toContain(
      'supported: at most 20 locales are allowed',
    );
  });
});

describe('validateMessages', () => {
  it('accepts a known key and keeps the value', () => {
    const result = validateMessages({ 'login.title': 'ورود به پنل مشتریان' });
    expect(result.problems).toEqual([]);
    expect(result.messages).toEqual({ 'login.title': 'ورود به پنل مشتریان' });
  });

  it('reports every unknown key separately from the rest of the payload', () => {
    const result = validateMessages({
      'login.title': 'ورود',
      'login.unknown': 'x',
      'attacker.key': 'y',
    });
    expect(result.unknownKeys).toEqual(['attacker.key', 'login.unknown']);
    expect(result.problems).toContain('unknown translation key(s): attacker.key, login.unknown');
    expect(result.messages).toEqual({ 'login.title': 'ورود' });
  });

  it('turns an empty or whitespace-only value into a deletion', () => {
    const result = validateMessages({ 'login.title': '', 'login.submit': '   ' });
    expect(result.problems).toEqual([]);
    expect(result.deletions).toEqual(['login.title', 'login.submit']);
    expect(result.messages).toEqual({});
  });

  it('rejects markup, control characters and over-long values', () => {
    const result = validateMessages({
      'login.title': '<script>alert(1)</script>',
      'login.submit': 'x'.repeat(MAX_MESSAGE_LENGTH + 1),
      'login.password': 'bad\u0000value',
    });
    expect(result.problems).toContain('login.title: must be plain text (no HTML or script)');
    expect(result.problems).toContain(
      `login.submit: must be at most ${MAX_MESSAGE_LENGTH} characters`,
    );
    expect(result.problems).toContain('login.password: contains control characters');
  });

  it('allows placeholders defined by the base message and rejects new ones', () => {
    const accepted = validateMessages({
      'admin.pageOf': 'صفحه {page} از {lastPage}',
      'login.attempts': '{count, plural, one {یک تلاش} other {# تلاش}}',
    });
    expect(accepted.problems).toEqual([]);

    const rejected = validateMessages({ 'login.title': 'سلام {name} {adminToken}' });
    expect(rejected.problems).toContain('login.title: placeholder(s) not allowed: adminToken');
  });

  it('rejects unbalanced placeholders and non-string values', () => {
    const result = validateMessages({
      'login.title': 'سلام {name',
      'login.submit': 42,
    });
    expect(result.problems).toContain('login.title: has unbalanced placeholders');
    expect(result.problems).toContain('login.submit: must be a string');
  });

  it('rejects an empty or non-object payload', () => {
    expect(validateMessages({}).problems).toContain('messages: at least one message is required');
    expect(validateMessages('nope').problems).toContain('messages: must be an object');
  });
});

describe('message helpers', () => {
  it('exposes the base bundle as the key allowlist', () => {
    expect(BASE_MESSAGE_KEYS.has('login.title')).toBe(true);
    expect(BASE_MESSAGE_KEYS.has('login.not_real')).toBe(false);
  });

  it('extracts ICU and simple placeholder names', () => {
    expect([...placeholderNames('{count, plural, one {#} other {#}} {name}')]).toEqual([
      'count',
      'name',
    ]);
  });

  it('checks brace balance', () => {
    expect(bracesBalanced('a {b} c')).toBe(true);
    expect(bracesBalanced('a {b')).toBe(false);
    expect(bracesBalanced('a } b')).toBe(false);
  });

  it('rejects unsafe values stored before validation existed', () => {
    expect(isSafeStoredMessage('ورود')).toBe(true);
    expect(isSafeStoredMessage('<b>ورود</b>')).toBe(false);
    expect(isSafeStoredMessage('')).toBe(false);
    expect(isSafeStoredMessage('x'.repeat(MAX_MESSAGE_LENGTH + 1))).toBe(false);
  });
});
