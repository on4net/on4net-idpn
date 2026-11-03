import { MESSAGES } from '@idpn/i18n';
import { describe, expect, it } from 'vitest';

import { buildTranslationBundle } from './bundle.js';
import { bundleCacheKey, createMemoryBundleCache } from './cache.js';
import { normalizeLocaleSettings } from './locale-settings.js';

const settings = normalizeLocaleSettings({
  default: 'fa-IR',
  supported: ['fa-IR', 'en-US'],
  calendar: 'persian',
  version: '2026-10-19T10:00:00.000Z',
});

describe('buildTranslationBundle', () => {
  it('merges overrides over the base bundle and returns metadata', () => {
    const bundle = buildTranslationBundle({
      locale: 'fa-IR',
      settings,
      overrides: { 'login.title': 'ورود به پنل مشتریان' },
    });

    expect(bundle).not.toBeNull();
    expect(bundle?.locale).toBe('fa-IR');
    expect(bundle?.dir).toBe('rtl');
    expect(bundle?.calendar).toBe('persian');
    expect(bundle?.version).toBe('2026-10-19T10:00:00.000Z');
    expect(bundle?.messages['login.title']).toBe('ورود به پنل مشتریان');
    expect(bundle?.messages['login.submit']).toBe(MESSAGES['fa-IR']['login.submit']);
    expect(Object.keys(bundle?.messages ?? {})).toEqual(Object.keys(MESSAGES['fa-IR']));
  });

  it('never returns unknown keys or unsafe stored values', () => {
    const bundle = buildTranslationBundle({
      locale: 'fa-IR',
      settings,
      overrides: {
        'evil.key': 'leak',
        'login.title': '<script>alert(1)</script>',
      },
    });

    expect(bundle?.messages['evil.key']).toBeUndefined();
    expect(bundle?.messages['login.title']).toBe(MESSAGES['fa-IR']['login.title']);
  });

  it('uses the LTR direction for English', () => {
    const bundle = buildTranslationBundle({ locale: 'en-US', settings, overrides: {} });
    expect(bundle?.dir).toBe('ltr');
  });

  it('returns null when no base bundle exists for the locale', () => {
    expect(buildTranslationBundle({ locale: 'de-DE', settings, overrides: {} })).toBeNull();
  });
});

describe('bundle cache', () => {
  it('builds a case-insensitive per-client key', () => {
    expect(bundleCacheKey('app-a', 'fa-IR')).toBe('idpn:translations:bundle:app-a:fa-ir');
  });

  it('stores and invalidates entries', async () => {
    const cache = createMemoryBundleCache();
    await cache.set('k', 'v', 300);
    await expect(cache.get('k')).resolves.toBe('v');
    await cache.delete('k');
    await expect(cache.get('k')).resolves.toBeNull();
  });
});
