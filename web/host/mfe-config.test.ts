import { describe, expect, it, vi } from 'vitest';

import { SAME_ORIGIN_API_BASE, toMfeConfig, type HostModuleSettings } from './mfe-config';

const TOKEN = 'in-memory-access-token-1';

const settings = (overrides: Partial<HostModuleSettings> = {}): HostModuleSettings => ({
  clientId: 'app-a',
  mode: 'bff',
  apiBaseUrl: '',
  locale: 'fa-IR',
  dir: 'rtl',
  onEvent: vi.fn(),
  ...overrides,
});

describe('toMfeConfig', () => {
  it('maps an empty host apiBaseUrl to the same-origin path the SDK accepts', () => {
    const config = toMfeConfig(settings(), 'user-management');

    expect(config.apiBaseUrl).toBe(SAME_ORIGIN_API_BASE);
    expect(config.clientId).toBe('app-a');
    expect(config.mode).toBe('bff');
    expect(config.module).toBe('user-management');
    expect(config.locale).toBe('fa-IR');
    expect(config.dir).toBe('rtl');
  });

  it('keeps an explicit apiBaseUrl untouched', () => {
    const config = toMfeConfig(settings({ apiBaseUrl: '/auth' }), 'account');

    expect(config.apiBaseUrl).toBe('/auth');
  });

  it('omits theme and token getter when the host does not configure them', () => {
    const config = toMfeConfig(settings(), 'account');

    expect(config.theme).toBeUndefined();
    expect(config.getAccessToken).toBeUndefined();
  });

  it('forwards theme tokens and the handler as SDK configuration', () => {
    const onEvent = vi.fn();
    const config = toMfeConfig(settings({ theme: { primary: '#0057b8' }, onEvent }), 'account');

    expect(config.theme).toEqual({ primary: '#0057b8' });
    expect(config.onEvent).toBe(onEvent);
  });

  it('never forwards a token getter in bff mode', () => {
    const config = toMfeConfig(
      settings({ mode: 'bff', getAccessToken: () => TOKEN }),
      'user-management',
    );

    expect(config.getAccessToken).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain(TOKEN);
  });

  it('forwards the in-memory getter in spa mode for user-management only', () => {
    const getAccessToken = () => TOKEN;

    const userManagement = toMfeConfig(
      settings({ mode: 'spa', getAccessToken }),
      'user-management',
    );
    const account = toMfeConfig(settings({ mode: 'spa', getAccessToken }), 'account');

    expect(userManagement.getAccessToken).toBe(getAccessToken);
    // `account` is documented as BFF-only; it must keep using the session cookie.
    expect(account.getAccessToken).toBeUndefined();
  });

  it('keeps every serializable config field free of token material', () => {
    const config = toMfeConfig(
      settings({ mode: 'spa', getAccessToken: () => TOKEN }),
      'user-management',
    );
    const { getAccessToken: _getAccessToken, onEvent: _onEvent, ...serializable } = config;

    expect(JSON.stringify(serializable)).not.toMatch(/token|bearer|secret/i);
  });
});
