import { describe, expect, it } from 'vitest';

import {
  brandingProblems,
  clientInputProblems,
  membershipSchemaProblems,
  mfeFeatureProblems,
  scopeProblems,
  ttlProblems,
  uriListProblems,
  uriProblem,
  type ClientInput,
} from './client-validation.js';

const adminClientId = 'admin-panel';

const baseInput = (overrides: Partial<ClientInput> = {}): ClientInput => ({
  clientId: 'app-a',
  type: 'web',
  redirectUris: ['https://app-a.example.com/auth/callback'],
  postLogoutRedirectUris: ['https://app-a.example.com/'],
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  accessTokenTtl: 600,
  refreshTokenTtl: 2_592_000,
  ...overrides,
});

describe('uriProblem', () => {
  it('accepts https URIs and loopback http', () => {
    expect(uriProblem('https://app.example.com/cb')).toBeNull();
    expect(uriProblem('http://localhost:3001/cb')).toBeNull();
    expect(uriProblem('http://127.0.0.1:3200/auth/callback')).toBeNull();
  });

  it('rejects wildcards, fragments, credentials, plain http and relative values', () => {
    expect(uriProblem('https://app.example.com/*')).toContain('wildcards');
    expect(uriProblem('https://app.example.com/cb#frag')).toContain('fragment');
    expect(uriProblem('https://user:pass@app.example.com/cb')).toContain('credentials');
    expect(uriProblem('http://app.example.com/cb')).toContain('must use https');
    expect(uriProblem('/relative/callback')).toContain('absolute');
    expect(uriProblem('ftp://app.example.com/cb')).toContain('https scheme');
    expect(uriProblem(' https://app.example.com/cb')).toContain('whitespace');
  });

  it('reports duplicates and keeps the index of each bad entry', () => {
    const problems = uriListProblems(
      ['https://a.example.com/cb', 'https://a.example.com/cb', 'http://evil.example/cb'],
      'redirectUris',
    );
    expect(problems).toEqual([
      'redirectUris[1]: duplicate entry',
      'redirectUris[2]: must use https (http is only allowed for loopback addresses)',
    ]);
  });
});

describe('scopeProblems', () => {
  const scopes = (values: string[], extra: { type?: 'web' | 'm2m'; clientId?: string } = {}) =>
    scopeProblems({
      scopes: values,
      type: extra.type ?? 'web',
      clientId: extra.clientId ?? 'app-a',
      adminClientId,
    });

  it('accepts the platform scope set', () => {
    expect(scopes(['openid', 'profile', 'offline_access'])).toEqual([]);
  });

  it('requires at least one scope and rejects unknown ones', () => {
    expect(scopes([])).toContain('scopes: at least one scope is required');
    expect(scopes(['openid', 'superpowers'])[0]).toContain('unknown scope(s) superpowers');
  });

  it('requires openid for interactive clients only', () => {
    expect(scopes(['profile'])).toContain('scopes: openid is required');
    expect(scopes(['reports:read'], { type: 'm2m' })).toEqual([]);
  });

  it('reserves idp.admin for the configured admin client', () => {
    expect(scopes(['openid', 'idp.admin'])[0]).toContain('reserved');
    expect(scopes(['openid', 'idp.admin'], { clientId: adminClientId })).toEqual([]);
  });
});

describe('ttlProblems', () => {
  it('bounds both TTLs', () => {
    expect(ttlProblems(600, 2_592_000)).toEqual([]);
    expect(ttlProblems(30, 60)).toEqual([
      'accessTokenTtl: must be between 60 and 3600',
      'refreshTokenTtl: must be between 300 and 31536000',
    ]);
    expect(ttlProblems(undefined, undefined)).toEqual([]);
  });
});

describe('brandingProblems', () => {
  it('accepts known string keys and validates the logo URI', () => {
    expect(
      brandingProblems({ logoUrl: 'https://cdn.example.com/logo.svg', primaryColor: '#0f766e' }),
    ).toEqual([]);
    expect(brandingProblems({ logoUrl: 'http://cdn.example.com/logo.svg' })[0]).toContain(
      'branding.logoUrl',
    );
  });

  it('rejects unknown keys and non-string values', () => {
    expect(brandingProblems({ evil: 'x' })).toEqual(['branding.evil: unknown key']);
    expect(brandingProblems({ primaryColor: 12 })).toEqual([
      'branding.primaryColor: must be a non-empty string',
    ]);
    expect(brandingProblems([])).toEqual(['branding: must be an object']);
  });
});

describe('mfeFeatureProblems', () => {
  it('requires boolean flags', () => {
    expect(mfeFeatureProblems({ userManagement: true })).toEqual([]);
    expect(mfeFeatureProblems({ userManagement: 'yes' })).toEqual([
      'mfeFeatures.userManagement: must be a boolean',
    ]);
    expect(mfeFeatureProblems('nope')).toEqual(['mfeFeatures: must be an object']);
  });
});

describe('membershipSchemaProblems', () => {
  it('requires an object schema', () => {
    expect(membershipSchemaProblems(undefined)).toEqual([]);
    expect(
      membershipSchemaProblems({
        type: 'object',
        properties: { department: { type: 'string' } },
      }),
    ).toEqual([]);
    expect(membershipSchemaProblems({ type: 'array' })).toEqual([
      'membershipSchema.type: must be "object"',
    ]);
    expect(membershipSchemaProblems({ type: 'object', properties: [] })).toEqual([
      'membershipSchema.properties: must be an object',
    ]);
    expect(membershipSchemaProblems(['x'])).toEqual(['membershipSchema: must be a JSON object']);
  });
});

describe('clientInputProblems', () => {
  it('accepts a well-formed client', () => {
    expect(clientInputProblems(baseInput(), { adminClientId })).toEqual([]);
  });

  it('rejects a bad redirect URI and a missing redirect list', () => {
    expect(
      clientInputProblems(baseInput({ redirectUris: ['https://app.example.com/*'] }), {
        adminClientId,
      }),
    ).toEqual(['redirectUris[0]: wildcards are not allowed']);

    expect(
      clientInputProblems(baseInput({ redirectUris: [], postLogoutRedirectUris: [] }), {
        adminClientId,
      }),
    ).toEqual(['redirectUris: at least one redirect URI is required']);
  });

  it('validates the back-channel URIs', () => {
    expect(
      clientInputProblems(baseInput({ backchannelLogoutUri: 'http://app.example.com/bc' }), {
        adminClientId,
      }),
    ).toEqual([
      'backchannelLogoutUri: must use https (http is only allowed for loopback addresses)',
    ]);

    expect(
      clientInputProblems(baseInput({ frontchannelLogoutUri: 'not-a-uri' }), { adminClientId }),
    ).toEqual(['frontchannelLogoutUri: must be an absolute URI']);
  });

  it('allows an m2m client without redirect URIs', () => {
    expect(
      clientInputProblems(
        baseInput({
          type: 'm2m',
          redirectUris: [],
          postLogoutRedirectUris: [],
          scopes: ['reports:read'],
        }),
        { adminClientId },
      ),
    ).toEqual([]);
  });
});
