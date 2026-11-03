import { describe, expect, it } from 'vitest';

import type { IdpnLocales } from './contract.js';
import {
  idpnDirectionOf,
  isIdpnDirection,
  isIdpnLocaleCode,
  resolveMfeDirection,
  resolveMfeLocale,
} from './locale.js';

const locales: IdpnLocales = {
  default: 'fa-IR',
  supported: ['fa-IR', 'en-US'],
  dir: { 'fa-IR': 'rtl', 'en-US': 'ltr' },
};

describe('SDK locale resolution', () => {
  it('honours an explicit enabled locale', () => {
    expect(resolveMfeLocale('en-US', locales)).toBe('en-US');
    expect(resolveMfeLocale('en', locales)).toBe('en-US');
  });

  it('falls back to the client default, then fa-IR', () => {
    expect(resolveMfeLocale('de-DE', locales)).toBe('fa-IR');
    expect(resolveMfeLocale(undefined, locales)).toBe('fa-IR');
    expect(resolveMfeLocale(undefined, { ...locales, default: 'en-US' })).toBe('en-US');
    expect(resolveMfeLocale('de-DE', undefined)).toBe('fa-IR');
  });

  it('never emits a locale the SDK has no bundle for', () => {
    expect(
      resolveMfeLocale('ar-SA', {
        default: 'ar-SA',
        supported: ['ar-SA'],
        dir: { 'ar-SA': 'rtl' },
      }),
    ).toBe('fa-IR');
    expect(
      resolveMfeLocale('en-US', {
        default: 'ar-SA',
        supported: ['ar-SA'],
        dir: { 'ar-SA': 'rtl' },
      }),
    ).toBe('fa-IR');
  });

  it('resolves direction from explicit config, locales.dir, then the locale', () => {
    expect(resolveMfeDirection('fa-IR', 'ltr', locales)).toBe('ltr');
    expect(resolveMfeDirection('fa-IR', undefined, locales)).toBe('rtl');
    expect(resolveMfeDirection('en-US', undefined, { ...locales, dir: { 'en-US': 'rtl' } })).toBe(
      'rtl',
    );
    expect(resolveMfeDirection('ar-SA', undefined, undefined)).toBe('rtl');
    expect(resolveMfeDirection('tr-TR', undefined, undefined)).toBe('ltr');
  });

  it('exposes validation helpers', () => {
    expect(isIdpnLocaleCode('fa-IR')).toBe(true);
    expect(isIdpnLocaleCode('<x>')).toBe(false);
    expect(isIdpnDirection('rtl')).toBe(true);
    expect(isIdpnDirection('up')).toBe(false);
    expect(idpnDirectionOf('he')).toBe('rtl');
  });
});
