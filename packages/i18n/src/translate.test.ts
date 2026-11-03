import { describe, expect, it } from 'vitest';

import { createTranslator, formatMessage, SAFE_FALLBACK, translate } from './translate.js';

describe('interpolation', () => {
  it('replaces named placeholders', () => {
    expect(translate('fa-IR', 'login.social.continueWith', { provider: 'Google' })).toBe(
      'ادامه با Google',
    );
    expect(translate('en-US', 'members.pageOf', { page: 2, pageCount: 3 })).toBe('Page 2 of 3');
    expect(translate('fa-IR', 'members.tableCaption', { clientId: 'app-a' })).toBe(
      'اعضای اپ app-a',
    );
  });

  it('leaves the placeholder visible when no value is supplied', () => {
    expect(translate('en-US', 'members.tableCaption')).toBe('Members of {clientId}');
  });

  it('renders unbalanced braces literally instead of throwing', () => {
    expect(formatMessage('hello {name', { name: 'Sara' }, 'en-US')).toBe('hello {name');
  });
});

describe('ICU plural and select', () => {
  it('selects the plural category of the locale', () => {
    expect(translate('en-US', 'login.attempts', { count: 1 })).toBe('1 attempt');
    expect(translate('en-US', 'login.attempts', { count: 3 })).toBe('3 attempts');
    expect(translate('fa-IR', 'login.attempts', { count: 2 })).toBe('۲ تلاش');
  });

  it('supports exact plural matches and select', () => {
    const template = '{count, plural, =0 {none} one {one item} other {# items}}';
    expect(formatMessage(template, { count: 0 }, 'en-US')).toBe('none');
    expect(formatMessage(template, { count: 2 }, 'en-US')).toBe('2 items');
    const select = '{kind, select, admin {Administrator} other {Member}}';
    expect(formatMessage(select, { kind: 'admin' }, 'en-US')).toBe('Administrator');
    expect(formatMessage(select, { kind: 'user' }, 'en-US')).toBe('Member');
  });
});

describe('missing-key fallback chain', () => {
  it('falls back to the base bundle of the active locale', () => {
    expect(translate('en-US', 'members.title', {}, { messages: { 'en-US': {} } })).toBe(
      'Member management',
    );
    expect(
      translate(
        'en-US',
        'members.title',
        {},
        {
          messages: { 'en-US': { 'login.title': 'Customer portal' } },
        },
      ),
    ).toBe('Member management');
  });

  it('falls back to the default locale bundle when the active locale has none', () => {
    expect(translate('de-DE', 'members.title')).toBe('مدیریت کاربران');
    expect(translate('de-DE', 'members.title', {}, { defaultLocale: 'en-US' })).toBe(
      'Member management',
    );
  });

  it('renders the key in development/tests so the gap is visible', () => {
    expect(translate('en-US', 'missing.key')).toBe('missing.key');
    expect(translate('en-US', 'missing.key', {}, { production: false })).toBe('missing.key');
  });

  it('never renders a raw key in production', () => {
    const rendered = translate('en-US', 'internal.secret.key', {}, { production: true });
    expect(rendered).toBe(SAFE_FALLBACK);
    expect(rendered).not.toContain('internal.secret.key');
  });

  it('returns a bound translator', () => {
    const t = createTranslator('en-US');
    expect(t('login.submit')).toBe('Sign in');
    expect(t('members.pageOf', { page: 1, pageCount: 2 })).toBe('Page 1 of 2');
  });
});
