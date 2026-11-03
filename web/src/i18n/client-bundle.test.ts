import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isSafeClientMessage,
  loadClientBundle,
  resolveBundleUrl,
  sanitizeClientBundle,
  supportedClientLocales,
} from './client-bundle';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sanitizeClientBundle', () => {
  it('merges validated overrides over the shared base bundle', () => {
    const bundle = sanitizeClientBundle(
      { messages: { 'login.title': 'ورود به پنل مشتریان' } },
      'fa-IR',
    );

    expect(bundle?.['login.title']).toBe('ورود به پنل مشتریان');
    // Keys absent from the bundle still resolve from the base package.
    expect(bundle?.['login.password']).toBe('رمز عبور');
  });

  it('drops unknown keys, empty values, markup and over-length text', () => {
    const bundle = sanitizeClientBundle(
      {
        messages: {
          'unknown.key': 'x',
          'login.title': '   ',
          'login.subtitle': '<b>markup</b>',
          'login.password': 'x'.repeat(501),
          'login.submit': 'Enter',
          'login.forgot': 42,
        },
      },
      'en-US',
    );

    expect(bundle?.['login.submit']).toBe('Enter');
    expect(bundle?.['login.title']).toBe('Sign in');
    expect(bundle?.['login.subtitle']).toBe('Enter your account details to continue.');
    expect(bundle?.['login.password']).toBe('Password');
    expect(bundle?.['login.forgot']).toBe('Forgot your password?');
    expect(bundle?.['unknown.key']).toBeUndefined();
  });

  it('returns null for a malformed response', () => {
    expect(sanitizeClientBundle(null, 'fa-IR')).toBeNull();
    expect(sanitizeClientBundle({ messages: [] }, 'fa-IR')).toBeNull();
    expect(sanitizeClientBundle({ messages: {} }, 'ar-SA' as 'fa-IR')).toBeNull();
  });

  it('rejects unsafe message shapes explicitly', () => {
    expect(isSafeClientMessage('plain text')).toBe(true);
    expect(isSafeClientMessage('')).toBe(false);
    expect(isSafeClientMessage('<script>')).toBe(false);
    expect(isSafeClientMessage('a\u0000b')).toBe(false);
    expect(isSafeClientMessage('unbalanced {')).toBe(false);
  });
});

describe('resolveBundleUrl', () => {
  const origin = 'https://auth.example.com';

  it('uses the canonical same-origin endpoint when the config has no URL', () => {
    expect(resolveBundleUrl({ clientId: 'app a', locale: 'fa-IR' }, origin)).toBe(
      '/api/v1/clients/app%20a/translations/bundle?locale=fa-IR',
    );
  });

  it('keeps a same-origin config URL and replaces any existing locale', () => {
    expect(
      resolveBundleUrl(
        {
          clientId: 'app-a',
          locale: 'en-US',
          translationsUrl: 'https://auth.example.com/custom/bundle?locale=fa-IR',
        },
        origin,
      ),
    ).toBe('/custom/bundle?locale=en-US');
  });

  it('falls back to the IdP path instead of fetching a foreign origin', () => {
    expect(
      resolveBundleUrl(
        {
          clientId: 'app-a',
          locale: 'fa-IR',
          translationsUrl: 'https://cdn.example.net/bundle',
        },
        origin,
      ),
    ).toBe('/api/v1/clients/app-a/translations/bundle?locale=fa-IR');
  });
});

describe('supportedClientLocales', () => {
  it('offers only locales that have a shipped base bundle', () => {
    expect(
      supportedClientLocales({
        locales: { supported: ['fa-IR', 'de-DE', 'en', 'en-US'] },
      }),
    ).toEqual(['fa-IR', 'en-US']);
  });

  it('returns no options when the client never loaded a locale list', () => {
    expect(supportedClientLocales(null)).toEqual([]);
    expect(supportedClientLocales({ locales: {} })).toEqual([]);
  });
});

describe('loadClientBundle', () => {
  it('requests the resolved URL and returns the sanitized bundle', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: { 'login.title': 'Client sign-in' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const bundle = await loadClientBundle({
      clientId: 'app-a',
      locale: 'en-US',
      translationsUrl: '/api/v1/clients/app-a/translations/bundle',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/clients/app-a/translations/bundle?locale=en-US',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
    expect(bundle?.['login.title']).toBe('Client sign-in');
    expect(bundle?.['login.submit']).toBe('Sign in');
  });

  it('throws on a non-2xx response so the caller can fall back', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(loadClientBundle({ clientId: 'app-a', locale: 'fa-IR' })).rejects.toThrow(/404/);
  });
});
