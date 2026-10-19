import { describe, expect, it } from 'vitest';

import {
  MFE_SCHEMA_VERSION,
  buildMfeConfigJsonSchema,
  buildMfeEventJsonSchema,
  buildOpenApiDocument,
  mfeConfigSchema,
  mfeEventSchema,
  publicClientConfigSchema,
  renderMfeConfigJsonSchema,
  renderMfeEventJsonSchema,
  renderOpenApiDocument,
} from './index.js';

const publicConfigFixture = {
  clientId: 'app-a',
  name: 'App A',
  logoUrl: 'https://app-a.example.com/logo.svg',
  locale: 'fa-IR',
  locales: {
    default: 'fa-IR',
    supported: ['fa-IR', 'en-US'],
    dir: { 'fa-IR': 'rtl', 'en-US': 'ltr' },
    version: '2026-10-18T12:00:00Z',
  },
  translationsUrl: 'https://auth.example.com/api/v1/clients/app-a/translations/bundle',
  theme: { primary: '#0f766e', radius: '8px' },
  registrationPolicy: 'invite_only',
  mfaPolicy: 'required_admins',
  loginContexts: [
    {
      key: 'customer-admin',
      name: 'Customer admin',
      description: 'Manages users and billing',
      methods: ['password', 'google'],
      mfaPolicy: 'required_all',
      registrationPolicy: 'invite_only',
      branding: {
        title: 'Customer admin console',
        logoUrl: 'https://app-a.example.com/admin.svg',
        theme: { primary: '#0f766e' },
      },
    },
  ],
  defaultLoginContext: 'customer-admin',
  socialProviders: [{ provider: 'google', label: 'Google' }],
  features: { userManagement: true, selfServiceRegistration: false, mfa: true },
  mfe: {
    version: '1.4.0',
    remoteEntry: 'https://cdn.example.com/idpn-mfe/1.4.0/remoteEntry.js',
  },
};

describe('public client config contract', () => {
  it('accepts the documented response shape', () => {
    expect(publicClientConfigSchema.parse(publicConfigFixture)).toEqual(publicConfigFixture);
  });

  it('rejects fields that are not public', () => {
    const result = publicClientConfigSchema.safeParse({
      ...publicConfigFixture,
      clientSecret: 'leaked',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an unknown login method', () => {
    const result = publicClientConfigSchema.safeParse({
      ...publicConfigFixture,
      loginContexts: [
        {
          key: 'customer-admin',
          name: 'Customer admin',
          methods: ['sms'],
          mfaPolicy: 'optional',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects context branding that is not documented or not an http(s) logo', () => {
    const context = publicConfigFixture.loginContexts[0]!;
    const cases = [
      { ...context, branding: { logoUrl: 'javascript:alert(1)' } },
      { ...context, branding: { title: 'Admin', rawCss: 'body{}' } },
      { ...context, branding: { theme: { primary: 'url(javascript:alert(1))' } } },
      { ...context, registrationPolicy: 'approval_required' },
    ];

    for (const loginContext of cases) {
      expect(
        publicClientConfigSchema.safeParse({
          ...publicConfigFixture,
          loginContexts: [loginContext],
        }).success,
      ).toBe(false);
    }
  });

  it('accepts a context without branding or registration policy', () => {
    const minimal = {
      key: 'support',
      name: 'Support',
      methods: ['password'],
      mfaPolicy: 'optional',
    };

    expect(
      publicClientConfigSchema.safeParse({
        ...publicConfigFixture,
        loginContexts: [minimal],
      }).success,
    ).toBe(true);
  });

  it('rejects locale bundles that are not internally consistent', () => {
    const cases = [
      { ...publicConfigFixture.locales, default: 'ar-SA' },
      { ...publicConfigFixture.locales, supported: ['fa-IR', 'fa-ir'] },
      { ...publicConfigFixture.locales, supported: ['fa-IR', 'en-US', '<script>'] },
      { ...publicConfigFixture.locales, dir: { 'fa-IR': 'rtl' } },
      { ...publicConfigFixture.locales, dir: { 'fa-IR': 'rtl', 'en-US': 'ltr', 'de-DE': 'ltr' } },
    ];
    for (const locales of cases) {
      expect(publicClientConfigSchema.safeParse({ ...publicConfigFixture, locales }).success).toBe(
        false,
      );
    }
  });

  it('requires locale to match locales.default and have a direction', () => {
    expect(
      publicClientConfigSchema.safeParse({ ...publicConfigFixture, locale: 'en-US' }).success,
    ).toBe(false);
    expect(
      publicClientConfigSchema.safeParse({
        ...publicConfigFixture,
        locales: { ...publicConfigFixture.locales, dir: { 'en-US': 'ltr' } },
      }).success,
    ).toBe(false);
  });
});

describe('MFE config contract', () => {
  const config = {
    clientId: 'app-a',
    mode: 'bff',
    apiBaseUrl: '/auth',
    loginUrl: 'https://auth.example.com/oauth2/authorize',
    locale: 'fa-IR',
    locales: {
      default: 'fa-IR',
      supported: ['fa-IR', 'en-US'],
      dir: { 'fa-IR': 'rtl', 'en-US': 'ltr' },
    },
    loginContext: 'customer-admin',
    theme: { primary: '#0f766e' },
    module: 'account',
    features: { userManagement: true },
  };

  it('accepts a valid host configuration', () => {
    expect(mfeConfigSchema.parse(config)).toEqual(config);
  });

  it('rejects an unsupported module, mode or extra field', () => {
    expect(mfeConfigSchema.safeParse({ ...config, module: 'login' }).success).toBe(false);
    expect(mfeConfigSchema.safeParse({ ...config, mode: 'implicit' }).success).toBe(false);
    expect(mfeConfigSchema.safeParse({ ...config, token: 'secret' }).success).toBe(false);
  });
});

describe('MFE event contract', () => {
  it('accepts every documented event type', () => {
    const events = [
      {
        type: 'auth:login',
        user: { id: 'user-1', displayName: 'Ali', email: 'ali@example.com' },
        loginContext: 'customer-admin',
      },
      { type: 'auth:logout', reason: 'global' },
      { type: 'auth:error', code: 'access_denied' },
      { type: 'profile:updated', user: { id: 'user-1', displayName: 'Ali' } },
      { type: 'locale:changed', locale: 'en-US', dir: 'ltr' },
      { type: 'context:changed', loginContext: 'customer-team' },
      { type: 'navigation:request', to: '/account/security' },
    ];

    for (const event of events) {
      expect(mfeEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
    }
  });

  it('rejects unknown events and token payloads', () => {
    expect(mfeEventSchema.safeParse({ type: 'auth:token', token: 'x' }).success).toBe(false);
    expect(
      mfeEventSchema.safeParse({
        type: 'auth:login',
        user: { id: 'user-1', displayName: 'Ali' },
        loginContext: 'customer-admin',
        accessToken: 'secret',
      }).success,
    ).toBe(false);
  });
});

describe('generated contract artifacts', () => {
  it('produces an OpenAPI 3.1 document', () => {
    const document = buildOpenApiDocument();

    expect(document.openapi).toBe('3.1.0');
    expect(document.paths).toHaveProperty('/healthz');
    expect(document.paths).toHaveProperty('/api/v1/clients/{clientId}/public-config');
    expect(document.components).toHaveProperty('schemas.PublicClientConfig');
  });

  it('versions the MFE JSON schemas', () => {
    for (const schema of [buildMfeConfigJsonSchema(), buildMfeEventJsonSchema()]) {
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.description).toContain(`schema version ${MFE_SCHEMA_VERSION}`);
    }
  });

  it('renders deterministic JSON artifacts', () => {
    const artifacts = [
      renderOpenApiDocument(),
      renderMfeConfigJsonSchema(),
      renderMfeEventJsonSchema(),
    ];

    for (const artifact of artifacts) {
      expect(artifact.endsWith('\n')).toBe(true);
      expect(() => JSON.parse(artifact)).not.toThrow();
    }
  });
});
