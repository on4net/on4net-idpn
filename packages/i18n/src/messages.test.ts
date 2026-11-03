import { describe, expect, it } from 'vitest';

import { BASE_LOCALES } from './locale.js';
import { bundleOf, isBaseLocale, MESSAGES } from './messages.js';
import { translate } from './translate.js';

describe('base bundles', () => {
  it('ships a bundle for every base locale', () => {
    for (const locale of BASE_LOCALES) {
      expect(isBaseLocale(locale)).toBe(true);
      expect(Object.keys(MESSAGES[locale]).length).toBeGreaterThan(0);
    }
    expect(bundleOf('ar-SA')).toBeUndefined();
    expect(isBaseLocale('de-DE')).toBe(false);
  });

  it('keeps the exact same key set in both locales', () => {
    const fa = Object.keys(MESSAGES['fa-IR']).sort();
    const en = Object.keys(MESSAGES['en-US']).sort();
    expect(en).toEqual(fa);
  });

  it('covers every documented namespace', () => {
    const keys = Object.keys(MESSAGES['fa-IR']);
    const namespaces = new Set(keys.map((key) => key.split('.')[0]));
    for (const namespace of [
      'login',
      'mfa',
      'consent',
      'logout',
      'account',
      'members',
      'admin',
      'audit',
      'sessions',
      'errors',
    ]) {
      expect(namespaces.has(namespace), namespace).toBe(true);
    }
  });

  it('has no empty message and no message identical to its key in both locales', () => {
    for (const locale of BASE_LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        expect(value.trim(), `${locale} ${key}`).not.toBe('');
        expect(value, `${locale} ${key}`).not.toBe(key);
      }
    }
  });

  it('translates the documented sample keys', () => {
    expect(translate('fa-IR', 'login.title')).toBe('ورود به حساب');
    expect(translate('en-US', 'login.title')).toBe('Sign in');
    expect(translate('fa-IR', 'mfa.title')).toBe('ورود دومرحله‌ای');
    expect(translate('en-US', 'mfa.title')).toBe('Two-step verification');
    expect(translate('en-US', 'errors.clientIdRequired')).toBe('client-id is required.');
    expect(translate('fa-IR', 'consent.title')).toBe('دسترسی‌های درخواستی');
    expect(translate('en-US', 'logout.title')).toBe('You have been signed out');
  });
});
