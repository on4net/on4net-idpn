import {
  IDPN_THEME_COLOR_KEYS as CONTRACT_THEME_COLOR_KEYS,
  IDPN_THEME_FONT_KEYS as CONTRACT_THEME_FONT_KEYS,
  MFE_SCHEMA_VERSION,
  idpnThemeSchema,
  mfeConfigSchema,
  mfeEventSchema,
  mfeEventTypeSchema,
  sanitizeIdpnTheme,
} from '@idpn/contracts';
import { describe, expect, it } from 'vitest';

import {
  IDPN_MFE_EVENT_NAME,
  IDPN_MFE_EVENT_TYPES,
  IDPN_MFE_MODULES,
  type IdpnEvent,
  type IdpnMfeConfig,
} from './contract.js';
import { IDPN_THEME_COLOR_KEYS, IDPN_THEME_FONT_KEYS, type IdpnTheme } from './theme.js';
import { assertIdpnMfeConfig } from './validate.js';
import { IDPN_MFE_CONTRACT_VERSION } from './version.js';

/**
 * Contract parity: the SDK must expose exactly the documented events and a config that is
 * a subset of the serializable contract. A breaking change in `@idpn/contracts` without a
 * corresponding SDK change fails here.
 */
describe('@idpn/mfe-sdk contract parity', () => {
  const events: IdpnEvent[] = [
    {
      type: 'auth:login',
      user: { id: 'u1', displayName: 'Sara', email: 'sara@example.com' },
      loginContext: 'default',
    },
    { type: 'auth:logout', reason: 'local' },
    { type: 'auth:error', code: 'access_denied' },
    { type: 'profile:updated', user: { id: 'u1', displayName: 'Sara' } },
    { type: 'locale:changed', locale: 'fa-IR', dir: 'rtl' },
    { type: 'context:changed', loginContext: 'admin' },
    { type: 'navigation:request', to: '/account' },
  ];

  it('uses the same contract version as @idpn/contracts', () => {
    expect(IDPN_MFE_CONTRACT_VERSION).toBe(MFE_SCHEMA_VERSION);
  });

  it('exposes exactly the documented event types', () => {
    expect([...IDPN_MFE_EVENT_TYPES].sort()).toEqual([...mfeEventTypeSchema.options].sort());
    expect(new Set(events.map((event) => event.type))).toEqual(new Set(IDPN_MFE_EVENT_TYPES));
  });

  it('keeps every event valid against the contract schema', () => {
    for (const event of events) {
      const result = mfeEventSchema.safeParse(event);
      expect(result.success, JSON.stringify(result.error)).toBe(true);
    }
  });

  it('keeps every event free of token or secret fields', () => {
    for (const event of events) {
      expect(Object.keys(event)).not.toContain('accessToken');
      expect(Object.keys(event)).not.toContain('refreshToken');
      expect(Object.keys(event)).not.toContain('idToken');
      expect(JSON.stringify(event)).not.toMatch(/secret|bearer/i);
    }
  });

  it('keeps the serializable config valid against the contract schema', () => {
    // Functions are host-side only and therefore not part of the JSON schema.
    const serializable = {
      clientId: 'app-a',
      module: 'user-management',
      mode: 'bff',
      apiBaseUrl: '/auth',
      loginUrl: 'https://auth.example.com/oauth2/authorize',
      locale: 'fa-IR',
      locales: {
        default: 'fa-IR',
        supported: ['fa-IR', 'en-US'],
        dir: { 'fa-IR': 'rtl', 'en-US': 'ltr' },
      },
      loginContext: 'default',
      theme: { primary: '#0057b8', radius: '8px' },
      basename: '/account',
      features: { userManagement: true, mfa: true },
    };

    const result = mfeConfigSchema.safeParse(serializable);
    expect(result.success, JSON.stringify(result.error)).toBe(true);
  });

  it('accepts the full SDK config at the runtime boundary', () => {
    const config: IdpnMfeConfig = {
      clientId: 'app-a',
      module: 'account',
      mode: 'spa',
      apiBaseUrl: 'https://auth.example.com',
      loginUrl: 'https://auth.example.com/oauth2/authorize',
      locale: 'fa-IR',
      dir: 'rtl',
      locales: {
        default: 'fa-IR',
        supported: ['fa-IR', 'en-US'],
        dir: { 'fa-IR': 'rtl', 'en-US': 'ltr' },
      },
      loginContext: 'default',
      theme: { primary: '#0057b8' },
      basename: '/account',
      features: { mfa: true },
      getAccessToken: () => 'in-memory-token',
      onEvent: () => undefined,
    };

    expect(() => assertIdpnMfeConfig(config)).not.toThrow();
  });

  it('covers every supported module', () => {
    expect([...IDPN_MFE_MODULES]).toEqual(['user-management', 'account']);
  });

  it('keeps the theme contract in parity with @idpn/contracts', () => {
    expect([...IDPN_THEME_COLOR_KEYS]).toEqual([...CONTRACT_THEME_COLOR_KEYS]);
    expect([...IDPN_THEME_FONT_KEYS]).toEqual([...CONTRACT_THEME_FONT_KEYS]);

    const theme: IdpnTheme = {
      background: '#ffffff',
      foreground: '#0a0a0a',
      primary: '#0f766e',
      primaryForeground: 'white',
      radius: '8px',
      fontFamily: { rtl: 'vazirmatn', ltr: 'inter' },
      dark: { background: '#0a0a0a' },
    };

    expect(idpnThemeSchema.safeParse(theme).success).toBe(true);
    expect(idpnThemeSchema.safeParse({ primary: 'url(javascript:alert(1))' }).success).toBe(false);

    const sanitized = sanitizeIdpnTheme({
      ...theme,
      border: 'red; } body { display: none',
      extra: '#123456',
    });
    expect(sanitized).not.toHaveProperty('extra');
    expect(sanitized).not.toHaveProperty('border');
    expect(idpnThemeSchema.safeParse(sanitized).success).toBe(true);
  });

  it('keeps the Web Component DOM event name stable for hosts', () => {
    // Renaming the event breaks every non-SDK host listener; treat it as a major change.
    expect(IDPN_MFE_EVENT_NAME).toBe('idpn:event');
  });

  it('does not allow token fields in the public types', () => {
    const configWithToken: IdpnMfeConfig = {
      clientId: 'app-a',
      module: 'account',
      mode: 'bff',
      apiBaseUrl: '/auth',
      // @ts-expect-error access tokens are not part of the public config contract
      accessToken: 'secret',
    };
    const eventWithToken: IdpnEvent = {
      type: 'auth:error',
      code: 'x',
      // @ts-expect-error events never carry access tokens
      accessToken: 'secret',
    };

    // The runtime guard is the second line of defence for untyped callers.
    expect(() => assertIdpnMfeConfig(configWithToken)).toThrow(TypeError);
    expect(eventWithToken.type).toBe('auth:error');
  });
});
