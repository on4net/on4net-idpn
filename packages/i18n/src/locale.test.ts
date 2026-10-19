import { describe, expect, it } from 'vitest';

import {
  directionOf,
  formatCurrency,
  formatDate,
  formatNumber,
  isDirection,
  isLocaleCode,
  matchLocale,
  normalizeLocale,
  parseAcceptLanguage,
  resolveDirection,
  resolveLocale,
} from './locale.js';

const both = ['fa-IR', 'en-US'] as const;

describe('locale precedence', () => {
  it('uses explicit host configuration before every other source', () => {
    expect(
      resolveLocale({
        configLocale: 'en-US',
        uiLocales: 'fa-IR',
        acceptLanguage: 'fa-IR',
        clientDefault: 'fa-IR',
        supported: both,
      }),
    ).toBe('en-US');
  });

  it('uses ui_locales before Accept-Language, profile and client defaults', () => {
    expect(
      resolveLocale({
        uiLocales: 'en-US fa-IR',
        acceptLanguage: 'fa-IR, en-US;q=0.5',
        profileLocale: 'fa-IR',
        clientDefault: 'fa-IR',
        supported: both,
      }),
    ).toBe('en-US');
    expect(
      resolveLocale({
        uiLocales: ['de-DE', 'en-US'],
        acceptLanguage: 'fa-IR',
        supported: both,
      }),
    ).toBe('en-US');
  });

  it('falls back to the highest-quality Accept-Language entry', () => {
    expect(
      resolveLocale({
        acceptLanguage: 'de-DE, fa-IR;q=0.4, en-US;q=0.9',
        clientDefault: 'fa-IR',
        supported: both,
      }),
    ).toBe('en-US');
  });

  it('uses the profile before the client and tenant defaults', () => {
    expect(
      resolveLocale({
        profileLocale: 'en-US',
        clientDefault: 'fa-IR',
        tenantDefault: 'fa-IR',
        supported: both,
      }),
    ).toBe('en-US');
    expect(resolveLocale({ clientDefault: 'en-US', tenantDefault: 'fa-IR', supported: both })).toBe(
      'en-US',
    );
  });

  it('uses the tenant default before the app default', () => {
    expect(resolveLocale({ tenantDefault: 'en-US', supported: both })).toBe('en-US');
    expect(resolveLocale({ tenantDefault: 'de-DE', appDefault: 'en-US', supported: both })).toBe(
      'en-US',
    );
  });

  it('skips invalid and unsupported values instead of throwing', () => {
    expect(
      resolveLocale({
        uiLocales: '<script>, fr-FR',
        acceptLanguage: 'not-a-locale',
        profileLocale: 'de-DE',
        clientDefault: 'en-US',
        supported: both,
      }),
    ).toBe('en-US');
    expect(resolveLocale({ uiLocales: 'de-DE', supported: both })).toBe('fa-IR');
  });

  it('resolves to the application default when nothing matches', () => {
    expect(resolveLocale()).toBe('fa-IR');
    expect(resolveLocale({ supported: [] })).toBe('fa-IR');
    expect(resolveLocale({ appDefault: 'en-US' })).toBe('en-US');
    expect(resolveLocale({ appDefault: 'en-US', supported: ['fa-IR'] })).toBe('fa-IR');
  });

  it('matches a language-only tag to the enabled regional variant', () => {
    expect(matchLocale('en', both)).toBe('en-US');
    expect(matchLocale('FA', both)).toBe('fa-IR');
    expect(matchLocale('fa-ir', both)).toBe('fa-IR');
    expect(matchLocale('*', both)).toBeUndefined();
    expect(matchLocale('de', both)).toBeUndefined();
  });

  it('only honours locales enabled by the client', () => {
    expect(resolveLocale({ uiLocales: 'en-US', supported: ['fa-IR'] })).toBe('fa-IR');
    expect(resolveLocale({ uiLocales: 'en-US', supported: ['en-US'] })).toBe('en-US');
    // A client that enables no locale with a bundle falls back to the app default.
    expect(resolveLocale({ uiLocales: 'en-US', supported: ['ar-SA'] })).toBe('fa-IR');
    // `available` documents the bundles this build ships; anything else is skipped.
    expect(resolveLocale({ uiLocales: 'ar-SA', available: ['fa-IR', 'en-US'] })).toBe('fa-IR');
  });
});

describe('Accept-Language parsing', () => {
  it('orders ranges by quality and keeps declaration order for ties', () => {
    expect(parseAcceptLanguage('fa-IR, en-US;q=0.9, ar;q=0.8')).toEqual(['fa-IR', 'en-US', 'ar']);
    expect(parseAcceptLanguage('en-US;q=0.5, fa-IR;q=0.5')).toEqual(['en-US', 'fa-IR']);
  });

  it('drops entries with q=0 or an invalid quality and ignores empty values', () => {
    expect(parseAcceptLanguage('fa-IR;q=0, en-US;q=nope, ar-SA;q=0.5')).toEqual(['ar-SA']);
    expect(parseAcceptLanguage('')).toEqual([]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage(',,')).toEqual([]);
  });
});

describe('direction', () => {
  it('derives RTL for fa, ar, he and ur and LTR for the rest', () => {
    expect(directionOf('fa-IR')).toBe('rtl');
    expect(directionOf('ar-SA')).toBe('rtl');
    expect(directionOf('he')).toBe('rtl');
    expect(directionOf('ur-PK')).toBe('rtl');
    expect(directionOf('en-US')).toBe('ltr');
    expect(directionOf('tr-TR')).toBe('ltr');
  });

  it('honours only a validated rtl/ltr override', () => {
    expect(resolveDirection('en-US', 'rtl')).toBe('rtl');
    expect(resolveDirection('fa-IR', 'ltr')).toBe('ltr');
    expect(resolveDirection('fa-IR', 'sideways')).toBe('rtl');
    expect(resolveDirection('fa-IR', null)).toBe('rtl');
    expect(isDirection('ltr')).toBe(true);
    expect(isDirection('LTR')).toBe(false);
  });
});

describe('locale helpers', () => {
  it('normalizes case and separators without accepting markup', () => {
    expect(normalizeLocale(' en_us ')).toBe('en-US');
    expect(normalizeLocale('FA-ir')).toBe('fa-IR');
    expect(normalizeLocale('<img src=x>')).toBeUndefined();
    expect(normalizeLocale('')).toBeUndefined();
    expect(isLocaleCode('fa-IR')).toBe(true);
    expect(isLocaleCode('fa_IR')).toBe(false);
  });

  it('formats dates, numbers and currency with Intl', () => {
    const date = new Date('2026-10-19T12:00:00Z');
    expect(formatDate('en-US', date, { year: 'numeric', timeZone: 'UTC' })).toBe('2026');
    expect(formatNumber('en-US', 1234.5)).toBe('1,234.5');
    expect(formatNumber('fa-IR', 1234)).toBe('۱٬۲۳۴');
    expect(formatCurrency('en-US', 12.5, 'USD')).toContain('$');
  });
});
