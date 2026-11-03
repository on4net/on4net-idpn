import { describe, expect, it } from 'vitest';

import {
  directionOf,
  formatCurrency,
  formatDate,
  formatMessage,
  formatNumber,
  isLocaleCode,
  matchLocale,
  MESSAGES,
  normalizeLocale,
  parseAcceptLanguage,
  resolveDirection,
  resolveLocale,
  SAFE_FALLBACK,
  translate,
  type Locale,
  type LocaleSources,
} from './index.js';

/**
 * Consolidated localization regression suite (docs/localization.md 3, 4, 5 and 9,
 * docs/testing.md UNIT-LOC-001..003 / LOC-001..012).
 *
 * The per-module tests already exercise the helpers; this suite is the matrix that guards
 * the documented behaviour end to end: resolution order, invalid input, fallback layers,
 * key/placeholder parity and deterministic Intl formatting. Every assertion uses exact
 * strings and fixed instants so a locale/ICU change is visible instead of silently green.
 */

const BOTH: readonly string[] = ['fa-IR', 'en-US'];

interface ResolutionCase {
  name: string;
  sources: LocaleSources;
  expected: Locale;
}

/** Documented Hosted order: ui_locales -> Accept-Language -> profile -> client -> app. */
const RESOLUTION_CASES: readonly ResolutionCase[] = [
  {
    name: 'ui_locales wins over every lower source',
    sources: {
      uiLocales: 'en-US',
      acceptLanguage: 'fa-IR',
      profileLocale: 'fa-IR',
      clientDefault: 'fa-IR',
      tenantDefault: 'fa-IR',
      supported: BOTH,
    },
    expected: 'en-US',
  },
  {
    name: 'the first enabled ui_locales entry wins',
    sources: { uiLocales: ['de-DE', 'en-US', 'fa-IR'], supported: BOTH },
    expected: 'en-US',
  },
  {
    name: 'an invalid ui_locales value falls through to Accept-Language',
    sources: {
      uiLocales: '<script>alert(1)</script>',
      acceptLanguage: 'en-US;q=0.8, fa-IR;q=0.7',
      supported: BOTH,
    },
    expected: 'en-US',
  },
  {
    name: 'an unsupported ui_locales value falls through',
    sources: { uiLocales: 'ar-SA', acceptLanguage: 'fa-IR', supported: BOTH },
    expected: 'fa-IR',
  },
  {
    name: 'Accept-Language is ordered by quality',
    sources: { acceptLanguage: 'fa-IR;q=0.2, en-US;q=0.9', supported: BOTH },
    expected: 'en-US',
  },
  {
    name: 'a malformed Accept-Language quality is skipped',
    sources: { acceptLanguage: 'en-US;q=abc, fa-IR;q=0.3', supported: BOTH },
    expected: 'fa-IR',
  },
  {
    name: 'an Accept-Language wildcard never matches',
    sources: { acceptLanguage: '*', clientDefault: 'en-US', supported: BOTH },
    expected: 'en-US',
  },
  {
    name: 'the profile locale wins over the client default',
    sources: { profileLocale: 'en-US', clientDefault: 'fa-IR', supported: BOTH },
    expected: 'en-US',
  },
  {
    name: 'the profile locale is normalized before matching',
    sources: { profileLocale: ' en_us ', clientDefault: 'fa-IR', supported: BOTH },
    expected: 'en-US',
  },
  {
    name: 'the client default wins when nothing higher matches',
    sources: { clientDefault: 'EN-us', supported: BOTH },
    expected: 'en-US',
  },
  {
    name: 'the tenant default is used before the app default',
    sources: { tenantDefault: 'en-US', appDefault: 'fa-IR', supported: BOTH },
    expected: 'en-US',
  },
  {
    name: 'the app default is used when no client/tenant value exists',
    sources: { appDefault: 'en-US', supported: BOTH },
    expected: 'en-US',
  },
  {
    name: 'the base default is fa-IR when nothing is configured',
    sources: {},
    expected: 'fa-IR',
  },
  {
    name: 'only locales enabled by the client are honoured',
    sources: { uiLocales: 'en-US', supported: ['fa-IR'] },
    expected: 'fa-IR',
  },
  {
    name: 'a language-only tag maps to the enabled regional variant',
    sources: { uiLocales: 'en', supported: BOTH },
    expected: 'en-US',
  },
  {
    name: 'a locale without a shipped bundle is skipped',
    sources: { uiLocales: 'ar-SA', supported: ['fa-IR', 'ar-SA'], available: BOTH },
    expected: 'fa-IR',
  },
  {
    name: 'an empty client allowlist still yields the app default',
    sources: { supported: [] },
    expected: 'fa-IR',
  },
  {
    name: 'ui_locales wins over explicit host configuration',
    sources: { configLocale: 'en-US', uiLocales: 'fa-IR', supported: BOTH },
    expected: 'fa-IR',
  },
  {
    name: 'explicit host configuration is used when there is no ui_locales',
    sources: { configLocale: 'en-US', acceptLanguage: 'fa-IR', supported: BOTH },
    expected: 'en-US',
  },
  {
    name: 'an invalid host configuration is ignored',
    sources: { configLocale: 'not a locale', uiLocales: 'fa-IR', supported: BOTH },
    expected: 'fa-IR',
  },
];

describe.each(RESOLUTION_CASES)('resolveLocale — $name', ({ sources, expected }) => {
  it(`resolves ${expected}`, () => {
    expect(resolveLocale(sources)).toBe(expected);
  });
});

describe('malformed locale input', () => {
  const INVALID: readonly unknown[] = [null, undefined, '', '  ', '*', '<img src=x>', 'fa IR'];
  const VALID: readonly [string, string][] = [
    ['en-US', 'en-US'],
    ['EN-us', 'en-US'],
    [' en_us ', 'en-US'],
    ['FA-ir', 'fa-IR'],
    ['en', 'en'],
  ];

  it.each(INVALID.map((value) => [String(value), value] as const))(
    'normalizeLocale(%s) rejects the value without throwing',
    (_label, value) => {
      expect(normalizeLocale(value as string | null | undefined)).toBeUndefined();
    },
  );

  it.each(VALID)('normalizeLocale(%s) is %s', (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected);
  });

  it.each([
    ['fa-IR', true],
    ['en-US', true],
    ['en_us', false],
    ['<script>', false],
    ['', false],
  ] as const)('isLocaleCode(%s) is %s', (value, expected) => {
    expect(isLocaleCode(value)).toBe(expected);
  });

  it.each([
    ['en', ['fa-IR', 'en-US'], 'en-US'],
    ['FA', ['fa-IR', 'en-US'], 'fa-IR'],
    ['fa-ir', ['fa-IR', 'en-US'], 'fa-IR'],
    ['en-GB', ['fa-IR', 'en-US'], 'en-US'],
    ['*', ['fa-IR', 'en-US'], undefined],
    ['de-DE', ['fa-IR', 'en-US'], undefined],
    ['<script>', ['fa-IR', 'en-US'], undefined],
  ] as const)('matchLocale(%s) returns %s', (candidate, supported, expected) => {
    expect(matchLocale(candidate, supported)).toBe(expected);
  });
});

describe('Accept-Language parsing matrix', () => {
  it.each([
    ['', []],
    [undefined, []],
    [null, []],
    [',,,;q=1', []],
    ['en-US;q=0', []],
    ['en-US;q=-1', []],
    ['en-US;q=abc', []],
    ['en-US;q=0.5, fa-IR;q=0.5', ['en-US', 'fa-IR']],
    ['fa-IR;q=0.2, en-US;q=0.9, ar;q=0.5', ['en-US', 'ar', 'fa-IR']],
    ['en-US;q=0.5;q=0.9', ['en-US']],
    ['  fa-IR  ', ['fa-IR']],
    ['en-US;foo=bar', ['en-US']],
    ['*', ['*']],
    ['de-DE;q=0.0001', ['de-DE']],
  ] as const)('parseAcceptLanguage(%s) -> %j', (header, expected) => {
    expect(parseAcceptLanguage(header)).toEqual(expected);
  });
});

describe('direction matrix', () => {
  it.each([
    ['fa-IR', 'rtl'],
    ['fa', 'rtl'],
    ['FA-ir', 'rtl'],
    ['ar-SA', 'rtl'],
    ['he', 'rtl'],
    ['ur-PK', 'rtl'],
    ['en-US', 'ltr'],
    ['tr-TR', 'ltr'],
    ['de-DE', 'ltr'],
  ] as const)('directionOf(%s) is %s', (locale, expected) => {
    expect(directionOf(locale)).toBe(expected);
  });

  it.each([
    ['fa-IR', 'rtl', 'rtl'],
    ['fa-IR', 'ltr', 'ltr'],
    ['en-US', 'rtl', 'rtl'],
    ['en-US', 'sideways', 'ltr'],
    ['en-US', null, 'ltr'],
    ['fa-IR', 'RTL', 'rtl'],
  ] as const)('resolveDirection(%s, %s) is %s', (locale, override, expected) => {
    expect(resolveDirection(locale, override)).toBe(expected);
  });
});

describe('message fallback layers', () => {
  it('prefers the per-client override for the active locale', () => {
    expect(
      translate(
        'en-US',
        'login.title',
        {},
        {
          messages: { 'en-US': { 'login.title': 'Customer portal sign-in' } },
        },
      ),
    ).toBe('Customer portal sign-in');
  });

  it('never leaks another locale override into the active locale', () => {
    expect(
      translate(
        'en-US',
        'login.title',
        {},
        {
          messages: { 'fa-IR': { 'login.title': 'ورود مشتریان' } },
        },
      ),
    ).toBe('Sign in');
  });

  it('falls back to the default-locale client override when the active locale has no base', () => {
    expect(
      translate(
        'de-DE',
        'login.title',
        {},
        {
          messages: { 'fa-IR': { 'login.title': 'ورود مشتریان' } },
        },
      ),
    ).toBe('ورود مشتریان');
    expect(
      translate(
        'en-US',
        'login.title',
        {},
        {
          messages: {
            'en-US': {},
            'fa-IR': { 'login.title': 'ورود مشتریان' },
          },
        },
      ),
    ).toBe('Sign in');
  });

  it('falls back to the shared base bundle when the client bundle lacks a key', () => {
    // The active locale base always wins before the default locale (fa-IR).
    expect(translate('en-US', 'members.title', {}, { messages: { 'en-US': {} } })).toBe(
      'Member management',
    );
    expect(translate('en-US', 'login.submit', {}, { messages: { 'en-US': {} } })).toBe('Sign in');
    expect(translate('de-DE', 'members.title')).toBe('مدیریت کاربران');
  });

  it('honours an explicit fallback locale for missing keys', () => {
    expect(
      translate(
        'de-DE',
        'members.title',
        {},
        {
          messages: { 'de-DE': {} },
          defaultLocale: 'en-US',
        },
      ),
    ).toBe('Member management');
  });

  it('renders the key outside production so the gap is visible', () => {
    expect(translate('en-US', 'missing.key')).toBe('missing.key');
    expect(translate('en-US', 'missing.key', {}, { production: false })).toBe('missing.key');
  });

  it.each([
    ['en-US', 'missing.key'],
    ['fa-IR', 'missing.key'],
    ['en-US', 'internal.secret.key'],
    ['fa-IR', 'login.not.real'],
  ] as const)('production %s never renders the raw key %s', (locale, key) => {
    const rendered = translate(locale, key, {}, { production: true });
    expect(rendered).toBe(SAFE_FALLBACK);
    expect(rendered).not.toContain(key);
  });

  it('keeps a translation that exists in both bundles', () => {
    expect(translate('en-US', 'login.title')).toBe('Sign in');
    expect(translate('fa-IR', 'login.title')).toBe('ورود به حساب');
  });
});

describe('bundle parity', () => {
  const baseKeys = Object.keys(MESSAGES['fa-IR']).sort();

  it('ships the same key set in both base locales', () => {
    expect(Object.keys(MESSAGES['en-US']).sort()).toEqual(baseKeys);
  });

  it('uses the same placeholder names in both locales for every key', () => {
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{\s*([A-Za-z][A-Za-z0-9_]*)\s*[,}]/g)]
        .map((match) => match[1] ?? '')
        .filter((name) => name !== '')
        .sort();

    const mismatches = baseKeys.filter((key) => {
      const fa = MESSAGES['fa-IR'][key] ?? '';
      const en = MESSAGES['en-US'][key] ?? '';
      return placeholders(fa).join(',') !== placeholders(en).join(',');
    });

    expect(mismatches).toEqual([]);
  });

  it('uses the same ICU plural/select arguments in both locales', () => {
    const argumentsOf = (value: string): string[] =>
      [...value.matchAll(/\{\s*([A-Za-z][A-Za-z0-9_]*)\s*,\s*(plural|select)\s*,/g)]
        .map((match) => `${match[1]}:${match[2]}`)
        .sort();

    const mismatches = baseKeys.filter((key) => {
      const fa = MESSAGES['fa-IR'][key] ?? '';
      const en = MESSAGES['en-US'][key] ?? '';
      return argumentsOf(fa).join(',') !== argumentsOf(en).join(',');
    });

    expect(mismatches).toEqual([]);
  });

  it('never ships an empty value or a value identical to its key', () => {
    for (const locale of ['fa-IR', 'en-US'] as const) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        expect(value.trim(), `${locale} ${key}`).not.toBe('');
        expect(value, `${locale} ${key}`).not.toBe(key);
      }
    }
  });
});

describe('interpolation and ICU output', () => {
  it.each([
    ['fa-IR', 'login.social.continueWith', { provider: 'Google' }, 'ادامه با Google'],
    ['en-US', 'members.pageOf', { page: 2, pageCount: 3 }, 'Page 2 of 3'],
    // Section 8 allows Latin digits inside Persian text; only plurals use locale digits.
    ['fa-IR', 'members.pageOf', { page: 2, pageCount: 3 }, 'صفحه 2 از 3'],
    ['fa-IR', 'members.tableCaption', { clientId: 'app-a' }, 'اعضای اپ app-a'],
    ['en-US', 'members.tableCaption', {}, 'Members of {clientId}'],
  ] as const)('translate(%s, %s) -> %s', (locale, key, values, expected) => {
    expect(translate(locale, key, values)).toBe(expected);
  });

  it.each([
    ['en-US', 1, '1 attempt'],
    ['en-US', 2, '2 attempts'],
    ['fa-IR', 1, 'یک تلاش'],
    ['fa-IR', 2, '۲ تلاش'],
    // CLDR classifies 0 as `one` in Persian, so the singular branch is correct.
    ['fa-IR', 0, 'یک تلاش'],
    ['fa-IR', 1234, '۱٬۲۳۴ تلاش'],
  ] as const)('plural %s count=%s -> %s', (locale, count, expected) => {
    expect(translate(locale, 'login.attempts', { count })).toBe(expected);
  });

  it('supports exact plural matches and select fallbacks', () => {
    const plural = '{count, plural, =0 {none} one {one item} other {# items}}';
    expect(formatMessage(plural, { count: 0 }, 'en-US')).toBe('none');
    expect(formatMessage(plural, { count: 2 }, 'en-US')).toBe('2 items');

    const select = '{kind, select, admin {Administrator} other {Member}}';
    expect(formatMessage(select, { kind: 'admin' }, 'en-US')).toBe('Administrator');
    expect(formatMessage(select, { kind: 'user' }, 'en-US')).toBe('Member');
    expect(formatMessage(select, { kind: 'unknown' }, 'fa-IR')).toBe('Member');
  });

  it('renders malformed templates literally instead of throwing', () => {
    expect(formatMessage('hello {name', { name: 'Sara' }, 'en-US')).toBe('hello {name');
    expect(formatMessage('closing } only', {}, 'fa-IR')).toBe('closing } only');
  });
});

describe('Intl formatting', () => {
  const INSTANT = new Date('2026-10-19T20:30:00.000Z');
  const UTC = 'UTC';
  const TEHRAN = 'Asia/Tehran';

  it.each([
    ['en-US', 1234567.89, {}, '1,234,567.89'],
    ['fa-IR', 1234567.89, {}, '۱٬۲۳۴٬۵۶۷٫۸۹'],
    ['en-US', 1234.5, { maximumFractionDigits: 0 }, '1,235'],
    ['fa-IR', 1234, { useGrouping: false }, '۱۲۳۴'],
    ['en-US', 0, {}, '0'],
    ['fa-IR', 0, {}, '۰'],
  ] as const)('formatNumber(%s, %s) -> %s', (locale, value, options, expected) => {
    expect(formatNumber(locale, value, options)).toBe(expected);
  });

  it.each([
    ['en-US-u-ca-gregory', { dateStyle: 'medium', timeZone: UTC }, 'Oct 19, 2026'],
    ['fa-IR-u-ca-persian', { dateStyle: 'medium', timeZone: UTC }, '۲۷ مهر ۱۴۰۵'],
    ['en-US-u-ca-gregory', { dateStyle: 'medium', timeZone: TEHRAN }, 'Oct 20, 2026'],
    ['fa-IR-u-ca-persian', { dateStyle: 'medium', timeZone: TEHRAN }, '۲۸ مهر ۱۴۰۵'],
  ] as const)('formatDate(%s, %s) -> %s', (locale, options, expected) => {
    expect(formatDate(locale, INSTANT, options)).toBe(expected);
  });

  it.each([
    ['en-US', 1250000, 'IRR', 'IRR\u00a01,250,000'],
    ['fa-IR', 1250000, 'IRR', '\u200eریال\u00a0۱٬۲۵۰٬۰۰۰'],
  ] as const)('formatCurrency(%s, %s %s) -> %s', (locale, value, currency, expected) => {
    expect(formatCurrency(locale, value, currency)).toBe(expected);
  });

  it('keeps the same instant stable across repeated calls', () => {
    const options = { dateStyle: 'full', timeStyle: 'long', timeZone: UTC } as const;
    expect(formatDate('en-US-u-ca-gregory', INSTANT, options)).toBe(
      'Monday, October 19, 2026 at 8:30:00 PM UTC',
    );
    expect(formatDate('en-US-u-ca-gregory', INSTANT, options)).toBe(
      formatDate('en-US-u-ca-gregory', INSTANT, options),
    );
  });
});
