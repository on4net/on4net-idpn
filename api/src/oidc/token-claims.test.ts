import { describe, expect, it } from 'vitest';

import type { AuthorizationCodeRecord } from './authorization-code.js';
import { accessClaimsFor, buildAccessTokenClaims } from './token-claims.js';
import type { EffectiveAccess } from './effective-access.js';

const code: AuthorizationCodeRecord = {
  codeHash: 'hash',
  clientId: 'app-a',
  userId: 'user-1',
  sessionId: 'session-1',
  redirectUri: 'https://app-a.example.com/callback',
  scope: ['openid', 'profile'],
  nonce: null,
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256',
  authTime: new Date('2026-10-19T09:00:00Z'),
  acr: 'urn:on4net:acr:pwd',
  amr: ['pwd'],
  expiresAt: new Date('2026-10-19T09:01:00Z'),
  consumedAt: null,
};

const profile = {
  id: 'user-1',
  username: 'ali',
  email: 'ali@example.com',
  emailVerified: true,
  displayName: 'Ali',
  locale: 'fa-IR',
  tenantId: 'tenant-1',
};

const access: EffectiveAccess = {
  roles: ['app-a:member'],
  permissions: ['app-a:contact:read'],
  membership: { context: null, status: 'active', attributes: { department: 'sales' } },
};

const input = {
  issuer: 'https://auth.example.com',
  clientId: 'app-a',
  profile,
  code,
  expiresInSeconds: 600,
  issuedAt: 1_760_000_000,
  jti: 'jti-1',
};

describe('accessClaimsFor', () => {
  it('returns roles, permissions and membership', () => {
    expect(accessClaimsFor(access)).toEqual({
      roles: ['app-a:member'],
      permissions: ['app-a:contact:read'],
      membership: access.membership,
    });
  });

  it('omits the membership claim when there is no membership', () => {
    expect(accessClaimsFor({ ...access, membership: null })).toEqual({
      roles: ['app-a:member'],
      permissions: ['app-a:contact:read'],
    });
  });

  it('returns nothing when access was not resolved', () => {
    expect(accessClaimsFor(undefined)).toEqual({});
  });

  it('falls back to userinfo when the claim set is too large', () => {
    const permissions = Array.from({ length: 200 }, (_, index) => `app-a:resource${index}:read`);
    const claims = accessClaimsFor({ roles: access.roles, permissions, membership: null });
    expect(claims).toEqual({ permissions_source: 'userinfo' });
  });
});

describe('buildAccessTokenClaims', () => {
  it('includes access claims next to the identity claims', () => {
    const claims = buildAccessTokenClaims({ ...input, access });
    expect(claims).toMatchObject({
      sub: 'user-1',
      aud: 'app-a',
      roles: ['app-a:member'],
      permissions: ['app-a:contact:read'],
      membership: access.membership,
    });
  });

  it('keeps the token free of role claims when no access source is wired', () => {
    const claims = buildAccessTokenClaims(input);
    expect(claims).not.toHaveProperty('roles');
    expect(claims).not.toHaveProperty('permissions');
    expect(claims).not.toHaveProperty('membership');
  });

  it('includes login_context when the code belongs to a context', () => {
    const claims = buildAccessTokenClaims({
      ...input,
      code: { ...code, loginContext: 'customer-admin' },
      access,
    });
    expect(claims.login_context).toBe('customer-admin');
  });
});
