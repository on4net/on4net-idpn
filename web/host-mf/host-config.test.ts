import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCALE,
  DEFAULT_LOGIN_CONTEXT,
  DEFAULT_LOGIN_URL,
  HostConfigError,
  directionOf,
  parseHostConfig,
  toModuleProps,
  type IdpnHostConfig,
} from './host-config';

const baseEnv = { VITE_IDPN_CLIENT_ID: 'app-a' } as const;

const configOf = (overrides: Record<string, string | undefined> = {}): IdpnHostConfig =>
  parseHostConfig({ ...baseEnv, ...overrides });

const issuesOf = (source: Record<string, string | undefined>) => {
  try {
    parseHostConfig(source);
  } catch (error) {
    if (error instanceof HostConfigError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error('expected HostConfigError');
};

describe('parseHostConfig', () => {
  it('defaults to BFF, same-origin API, Persian RTL and both modules', () => {
    const config = configOf();

    expect(config).toEqual({
      clientId: 'app-a',
      mode: 'bff',
      apiBaseUrl: '',
      loginUrl: DEFAULT_LOGIN_URL,
      loginContext: DEFAULT_LOGIN_CONTEXT,
      locale: DEFAULT_LOCALE,
      dir: 'rtl',
      modules: ['user-management', 'account'],
      theme: {},
    });
  });

  it('reads every documented field from the host environment', () => {
    const config = configOf({
      VITE_IDPN_MODE: 'SPA',
      VITE_IDPN_API_BASE_URL: 'https://app.example.com/auth',
      VITE_IDPN_LOGIN_URL: 'https://auth.example.com/oauth2/authorize',
      VITE_IDPN_LOGIN_CONTEXT: 'admin',
      VITE_IDPN_LOCALE: 'en-US',
      VITE_IDPN_DIR: 'auto',
      VITE_IDPN_MODULE: 'account',
      VITE_IDPN_THEME: '{"primary":"#0057b8","radius":"0.75rem"}',
    });

    expect(config.mode).toBe('spa');
    expect(config.apiBaseUrl).toBe('https://app.example.com/auth');
    expect(config.loginUrl).toBe('https://auth.example.com/oauth2/authorize');
    expect(config.loginContext).toBe('admin');
    expect(config.locale).toBe('en-US');
    expect(config.dir).toBe('ltr');
    expect(config.modules).toEqual(['account']);
    expect(config.theme).toEqual({ primary: '#0057b8', radius: '0.75rem' });
  });

  it('resolves the module selection without duplicating a module', () => {
    expect(configOf({ VITE_IDPN_MODULE: 'user-management' }).modules).toEqual(['user-management']);
    expect(configOf({ VITE_IDPN_MODULE: 'all' }).modules).toEqual(['user-management', 'account']);
  });

  it('treats empty env values as unset and honours explicit direction', () => {
    const config = configOf({
      VITE_IDPN_MODE: '',
      VITE_IDPN_LOGIN_URL: '',
      VITE_IDPN_LOCALE: '',
      VITE_IDPN_DIR: 'ltr',
    });

    expect(config.mode).toBe('bff');
    expect(config.loginUrl).toBe(DEFAULT_LOGIN_URL);
    expect(config.locale).toBe(DEFAULT_LOCALE);
    expect(config.dir).toBe('ltr');
  });

  it('never lets URL or query input override the configured client id', () => {
    const config = parseHostConfig({
      ...baseEnv,
      URL: 'http://127.0.0.1:5176/?clientId=attacker&loginContext=admin&mode=spa',
      clientId: 'attacker',
    });

    expect(config.clientId).toBe('app-a');
    expect(config.mode).toBe('bff');
    expect(config.loginContext).toBe(DEFAULT_LOGIN_CONTEXT);
  });

  it('reports every invalid key without echoing the value', () => {
    const issues = issuesOf({
      VITE_IDPN_CLIENT_ID: 'has space',
      VITE_IDPN_MODE: 'cookie-secret-value',
      VITE_IDPN_LOGIN_CONTEXT: '../etc/passwd',
    });

    expect(issues.map((issue) => issue.key)).toEqual([
      'VITE_IDPN_CLIENT_ID',
      'VITE_IDPN_MODE',
      'VITE_IDPN_LOGIN_CONTEXT',
    ]);
    for (const issue of issues) {
      expect(issue.message).not.toContain('cookie-secret-value');
      expect(issue.message).not.toContain('passwd');
    }
  });

  it('requires clientId', () => {
    const issues = issuesOf({});
    expect(issues).toEqual([{ key: 'VITE_IDPN_CLIENT_ID', message: 'is required' }]);
  });

  it.each([
    ['javascript:alert(1)', 'JAVASCRIPT'],
    ['//evil.example.com/authorize', 'PROTOCOL_RELATIVE'],
    ['auth', 'RELATIVE_WITHOUT_SLASH'],
  ])('rejects an unsafe login URL (%s)', (loginUrl, _reason) => {
    const issues = issuesOf({ ...baseEnv, VITE_IDPN_LOGIN_URL: loginUrl });
    expect(issues).toEqual([
      {
        key: 'VITE_IDPN_LOGIN_URL',
        message: 'must be an http(s) URL or a path starting with a single /',
      },
    ]);
  });

  it.each([
    ['not-json', /must be a JSON object/],
    ['[1,2,3]', /must be a JSON object/],
    ['{"brand":"#0057b8"}', /token "brand" is not part of the theme contract/],
    ['{"primary":"not-a-color"}', /valid CSS colour and radius/],
    ['{"primary":"#0057b8","radius":"huge"}', /valid CSS colour and radius/],
  ])('rejects an invalid theme (%s)', (theme, message) => {
    const issues = issuesOf({ ...baseEnv, VITE_IDPN_THEME: theme });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe('VITE_IDPN_THEME');
    expect(issues[0]?.message).toMatch(message);
  });
});

describe('toModuleProps', () => {
  it('sends no token getter in BFF mode even when the host owns one', () => {
    const props = toModuleProps(configOf(), {
      onEvent: () => undefined,
      getAccessToken: () => 'in-memory-token',
    });

    expect(props).not.toHaveProperty('getAccessToken');
    expect(props.clientId).toBe('app-a');
    expect(props.locale).toBe('fa-IR');
    expect(props.dir).toBe('rtl');
    expect(props).not.toHaveProperty('apiBaseUrl');
  });

  it('forwards the getter and the API base in SPA mode', () => {
    const getAccessToken = () => 'in-memory-token';
    const props = toModuleProps(
      configOf({ VITE_IDPN_MODE: 'spa', VITE_IDPN_API_BASE_URL: '/auth' }),
      {
        getAccessToken,
      },
    );

    expect(props.getAccessToken).toBe(getAccessToken);
    expect(props.apiBaseUrl).toBe('/auth');
    expect(props.onEvent).toBeUndefined();
  });
});

describe('directionOf', () => {
  it.each([
    ['fa-IR', 'rtl'],
    ['ar', 'rtl'],
    ['he-IL', 'rtl'],
    ['en-US', 'ltr'],
    ['de', 'ltr'],
  ] as const)('%s is %s', (locale, direction) => {
    expect(directionOf(locale)).toBe(direction);
  });
});
