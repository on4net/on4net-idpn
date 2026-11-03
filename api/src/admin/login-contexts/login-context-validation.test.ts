import { describe, expect, it } from 'vitest';

import {
  brandingProblems,
  loginContextInputProblems,
  loginContextKeyProblem,
  roleProblems,
  sessionTtlProblems,
  type LoginContextValidationInput,
} from './login-context-validation.js';

const clientRoleKeys = new Set(['app-a:member', 'app-a:customer-admin', 'app-a:viewer']);

const base = (
  overrides: Partial<LoginContextValidationInput> = {},
): LoginContextValidationInput => ({
  key: 'customer-admin',
  name: 'Customer admin',
  description: 'Manages users and billing',
  allowedRoles: ['app-a:customer-admin', 'app-a:member'],
  defaultRoles: ['app-a:member'],
  loginMethods: ['password', 'google'],
  mfaPolicy: 'required_all',
  registrationPolicy: 'invite_only',
  allowedEmailDomains: ['example.com'],
  sessionIdleTtl: 900,
  sessionAbsoluteTtl: 28_800,
  stepUpRequired: true,
  isDefault: false,
  branding: { title: 'Customer admin' },
  sortOrder: 1,
  ...overrides,
});

const validate = (overrides: Partial<LoginContextValidationInput> = {}): string[] =>
  loginContextInputProblems(base(overrides), { clientId: 'app-a', clientRoleKeys });

describe('loginContextKeyProblem', () => {
  it('accepts the documented key shape', () => {
    expect(loginContextKeyProblem('customer-admin')).toBeNull();
    expect(loginContextKeyProblem('a')).toBeNull();
    expect(loginContextKeyProblem('team2')).toBeNull();
  });

  it('rejects empty, too long and unsafe keys', () => {
    expect(loginContextKeyProblem('')).toContain('required');
    expect(loginContextKeyProblem('a'.repeat(65))).toContain('at most 64');
    expect(loginContextKeyProblem('Customer-Admin')).toContain('lowercase');
    expect(loginContextKeyProblem('customer_admin')).toContain('lowercase');
    expect(loginContextKeyProblem('-customer')).toContain('lowercase');
    expect(loginContextKeyProblem('customer-')).toContain('lowercase');
    expect(loginContextKeyProblem('customer admin')).toContain('lowercase');
  });
});

describe('roleProblems', () => {
  it('accepts only roles owned by the same client', () => {
    expect(
      roleProblems(
        { allowedRoles: ['app-a:member'], defaultRoles: ['app-a:member'] },
        { clientId: 'app-a', clientRoleKeys },
      ),
    ).toEqual([]);
  });

  it('rejects global idp:* roles with a dedicated message', () => {
    const problems = roleProblems(
      { allowedRoles: ['idp:superadmin'], defaultRoles: [] },
      { clientId: 'app-a', clientRoleKeys },
    );
    expect(problems).toEqual([
      'allowedRoles[0]: global role "idp:superadmin" cannot be granted by a login context',
    ]);
  });

  it('rejects roles of another client', () => {
    const problems = roleProblems(
      { allowedRoles: ['app-b:member'], defaultRoles: [] },
      { clientId: 'app-a', clientRoleKeys },
    );
    expect(problems).toEqual([
      'allowedRoles[0]: role "app-b:member" does not belong to client "app-a"',
    ]);
  });

  it('rejects defaultRoles outside allowedRoles', () => {
    const problems = roleProblems(
      { allowedRoles: ['app-a:member'], defaultRoles: ['app-a:customer-admin'] },
      { clientId: 'app-a', clientRoleKeys },
    );
    expect(problems).toEqual([
      'defaultRoles[0]: role "app-a:customer-admin" is not in allowedRoles',
    ]);
  });

  it('reports duplicates and unknown default roles', () => {
    const problems = roleProblems(
      { allowedRoles: ['app-a:member', 'app-a:member', 'app-a:ghost'], defaultRoles: [] },
      { clientId: 'app-a', clientRoleKeys },
    );
    expect(problems).toEqual([
      'allowedRoles[2]: role "app-a:ghost" does not belong to client "app-a"',
      'allowedRoles: duplicate role "app-a:member"',
    ]);
  });
});

describe('sessionTtlProblems', () => {
  it('accepts the documented defaults and enforces the bounds', () => {
    expect(sessionTtlProblems({ sessionIdleTtl: 1800, sessionAbsoluteTtl: 28_800 })).toEqual([]);
    expect(sessionTtlProblems({ sessionIdleTtl: 59, sessionAbsoluteTtl: 28_800 })[0]).toContain(
      'sessionIdleTtl',
    );
    expect(sessionTtlProblems({ sessionIdleTtl: 1800, sessionAbsoluteTtl: 120 })[0]).toContain(
      'sessionAbsoluteTtl',
    );
  });

  it('requires the absolute TTL to be at least the idle TTL', () => {
    expect(sessionTtlProblems({ sessionIdleTtl: 3600, sessionAbsoluteTtl: 1800 })).toEqual([
      'sessionAbsoluteTtl: must be greater than or equal to sessionIdleTtl',
    ]);
  });

  it('rejects non-integers', () => {
    const problems = sessionTtlProblems({ sessionIdleTtl: 1.5, sessionAbsoluteTtl: 28_800 });
    expect(problems[0]).toContain('sessionIdleTtl');
  });
});

describe('loginContextInputProblems', () => {
  it('accepts a documented context definition', () => {
    expect(validate()).toEqual([]);
  });

  it('validates name, description and sort order limits', () => {
    expect(validate({ name: '   ' })).toEqual(['name: is required']);
    expect(validate({ name: 'n'.repeat(121) })).toEqual(['name: must be at most 120 characters']);
    expect(validate({ description: 'd'.repeat(501) })).toEqual([
      'description: must be at most 500 characters',
    ]);
    expect(validate({ sortOrder: -1 })).toEqual([
      'sortOrder: must be an integer between 0 and 100000',
    ]);
  });

  it('accepts a null description and branding', () => {
    expect(validate({ description: null, branding: null })).toEqual([]);
  });

  it('enforces the supported login method set', () => {
    expect(validate({ loginMethods: [] })).toEqual([
      'loginMethods: at least one method is required',
    ]);
    expect(validate({ loginMethods: ['password', 'sms'] })).toEqual([
      'loginMethods[1]: unsupported method "sms" (allowed: password, google, facebook, otp, sso)',
    ]);
    expect(validate({ loginMethods: ['password', 'password'] })).toEqual([
      'loginMethods: duplicate method "password"',
    ]);
  });

  it('enforces the policy enums', () => {
    expect(validate({ mfaPolicy: 'sometimes' })).toEqual([
      'mfaPolicy: must be one of optional, required_admins, required_all',
    ]);
    expect(validate({ registrationPolicy: 'open' })).toEqual([
      'registrationPolicy: must be one of invite_only, self_service, disabled',
    ]);
  });

  it('validates allowed email domains', () => {
    expect(validate({ allowedEmailDomains: ['not a domain'] })).toEqual([
      'allowedEmailDomains[0]: must be a domain name such as example.com',
    ]);
    expect(validate({ allowedEmailDomains: ['example.com', 'example.com'] })).toEqual([
      'allowedEmailDomains: duplicate domain "example.com"',
    ]);
  });

  it('rejects an oversized branding payload', () => {
    const problems = validate({ branding: { title: 'x'.repeat(9 * 1024) } });
    expect(problems[0]).toContain('branding: must be at most 8192 bytes');
  });

  it('rejects branding that is not the documented presentation shape', () => {
    expect(validate({ branding: { title: 'Admin', rawCss: 'body{}' } })[0]).toContain(
      'branding:',
    );
    expect(validate({ branding: { logoUrl: 'javascript:alert(1)' } })[0]).toContain(
      'branding.logoUrl',
    );
    expect(validate({ branding: { theme: { primary: 'url(javascript:alert(1))' } } })[0]).toContain(
      'branding.theme',
    );
  });

  it('aggregates every problem instead of failing on the first', () => {
    const problems = validate({
      key: 'Bad Key',
      loginMethods: [],
      mfaPolicy: 'nope',
      sortOrder: 1.5,
    });
    expect(problems).toHaveLength(4);
  });
});

describe('brandingProblems', () => {
  it('accepts the documented presentation fields and a missing branding', () => {
    expect(brandingProblems(null)).toEqual([]);
    expect(
      brandingProblems({
        title: 'Customer admin',
        logoUrl: 'https://cdn.example.com/admin.svg',
        theme: { primary: '#0f766e' },
      }),
    ).toEqual([]);
  });

  it('rejects unknown keys so raw CSS cannot be stored', () => {
    expect(brandingProblems({ title: 'Admin', rawCss: 'body{}' })[0]).toContain('branding');
    expect(brandingProblems({ title: 'Admin', rawCss: 'body{}' })[0]).toContain('rawCss');
  });

  it('rejects a non-http(s) logo and invalid theme tokens', () => {
    expect(brandingProblems({ logoUrl: 'javascript:alert(1)' })).toEqual([
      'branding.logoUrl: must be an http(s) URL',
    ]);
    expect(brandingProblems({ theme: { primary: 'url(javascript:alert(1))' } })[0]).toContain(
      'branding.theme.primary',
    );
  });

  it('rejects a non-object or oversized branding payload', () => {
    expect(brandingProblems([] as unknown as Record<string, unknown>)).toEqual([
      'branding: must be an object',
    ]);
    expect(brandingProblems({ title: 'x'.repeat(9 * 1024) })[0]).toContain(
      'branding: must be at most 8192 bytes',
    );
  });
});
