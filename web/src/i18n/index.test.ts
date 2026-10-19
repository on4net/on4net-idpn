import { afterEach, describe, expect, it, vi } from 'vitest';

import { SAFE_FALLBACK } from '@idpn/i18n';

import { resolveDirection, resolveLocale, translate } from './index';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('web i18n wrapper', () => {
  it('renders the key only outside production', () => {
    expect(translate('en-US', 'missing.key')).toBe('missing.key');

    vi.stubEnv('MODE', 'production');
    expect(translate('en-US', 'missing.key')).toBe(SAFE_FALLBACK);
  });

  it('resolves locale and direction through the shared module', () => {
    expect(
      resolveLocale({
        uiLocales: 'de-DE',
        supported: ['fa-IR', 'en-US'],
        acceptLanguage: 'fa-IR',
      }),
    ).toBe('fa-IR');
    expect(resolveLocale({ uiLocales: 'en', supported: ['fa-IR', 'en-US'] })).toBe('en-US');
    expect(resolveDirection('fa-IR')).toBe('rtl');
    expect(resolveDirection('en-US', 'rtl')).toBe('rtl');
  });
});
