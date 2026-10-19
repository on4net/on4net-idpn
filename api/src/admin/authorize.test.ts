import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { authorizeAdminRequest, readBearerToken, type AdminGuardOptions } from './authorize.js';

const issuer = 'https://auth.example.com';

const request = (authorization?: string): FastifyRequest =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as FastifyRequest;

const permissions = (held: string[], delegated: string[] = []) => ({
  async globalPermissionsForUser(): Promise<string[]> {
    return held;
  },
  async clientPermissionsForUser(): Promise<string[]> {
    return delegated;
  },
});

const verifier = (payload: Record<string, unknown> | Error) => ({
  async verify(): Promise<Record<string, unknown>> {
    if (payload instanceof Error) {
      throw payload;
    }
    return payload;
  },
});

const adminToken = { sub: 'user-1', client_id: 'admin-panel', scope: 'openid idp.admin' };

/** Builds a structurally valid JWT so the guard can read the unverified `client_id`. */
const tokenWith = (payload: Record<string, unknown>): string =>
  'Bearer ' + `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

const delegatedToken = {
  sub: 'user-1',
  client_id: 'app-a',
  scope: 'openid idp.client-admin',
  auth_time: 1_760_000_000,
};

function guard(overrides: Partial<AdminGuardOptions> = {}): AdminGuardOptions {
  return {
    issuer,
    adminClientId: 'admin-panel',
    verifier: verifier(adminToken),
    permissions: permissions(['idp:user:read']),
    ...overrides,
  };
}

describe('authorizeAdminRequest', () => {
  it('accepts an admin-client token that holds the required permission', async () => {
    const result = await authorizeAdminRequest(request('Bearer token'), guard(), 'idp:user:read');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.userId).toBe('user-1');
      expect(result.principal.clientId).toBe('admin-panel');
      expect(result.principal.scopes).toEqual(['openid', 'idp.admin']);
      expect([...result.principal.permissions]).toEqual(['idp:user:read']);
    }
  });

  it('rejects a request without a bearer token', async () => {
    expect(await authorizeAdminRequest(request(), guard(), 'idp:user:read')).toMatchObject({
      ok: false,
      status: 401,
      error: 'invalid_token',
    });
    expect(
      await authorizeAdminRequest(request('Basic abc'), guard(), 'idp:user:read'),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects an invalid or expired token', async () => {
    const result = await authorizeAdminRequest(
      request('Bearer token'),
      guard({ verifier: verifier(new Error('JWTExpired')) }),
      'idp:user:read',
    );
    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
  });

  it('rejects a token with incomplete claims', async () => {
    const result = await authorizeAdminRequest(
      request('Bearer token'),
      guard({ verifier: verifier({ sub: 'user-1' }) }),
      'idp:user:read',
    );
    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
  });

  it('rejects a token issued to another client', async () => {
    const result = await authorizeAdminRequest(
      request('Bearer token'),
      guard({ verifier: verifier({ ...adminToken, client_id: 'app-a' }) }),
      'idp:user:read',
    );
    expect(result).toMatchObject({ ok: false, status: 403, error: 'insufficient_scope' });
  });

  it('rejects a token without the idp.admin scope', async () => {
    const result = await authorizeAdminRequest(
      request('Bearer token'),
      guard({ verifier: verifier({ ...adminToken, scope: 'openid profile' }) }),
      'idp:user:read',
    );
    expect(result).toMatchObject({ ok: false, status: 403, error: 'insufficient_scope' });
  });

  it('rejects a caller who does not hold the required permission', async () => {
    const result = await authorizeAdminRequest(request('Bearer token'), guard(), 'idp:user:write');
    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' });
  });
});

describe('readBearerToken', () => {
  it('parses case-insensitively and rejects empty or foreign schemes', () => {
    expect(readBearerToken('bearer abc.def-123_~+/=')).toBe('abc.def-123_~+/=');
    expect(readBearerToken('BearER xyz')).toBe('xyz');
    expect(readBearerToken('Bearer')).toBeNull();
    expect(readBearerToken('Bearer  ')).toBeNull();
    expect(readBearerToken('Token abc')).toBeNull();
    expect(readBearerToken(undefined)).toBeNull();
  });
});

describe('delegated admin mode', () => {
  const requirement = {
    permission: 'idp:role:read',
    delegatedPermission: 'idp:client-role:read',
    clientId: 'app-a',
  };

  it('accepts a delegated token for its own client', async () => {
    const result = await authorizeAdminRequest(
      request(tokenWith(delegatedToken)),
      guard({
        verifier: verifier(delegatedToken),
        permissions: permissions([], ['idp:client-role:read']),
      }),
      requirement,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.mode).toBe('delegated');
      expect(result.principal.clientId).toBe('app-a');
      expect([...result.principal.permissions]).toEqual(['idp:client-role:read']);
    }
  });

  it('rejects a delegated token for another client', async () => {
    const foreignToken = { ...delegatedToken, client_id: 'app-b' };
    const result = await authorizeAdminRequest(
      request(tokenWith(foreignToken)),
      guard({
        verifier: verifier(foreignToken),
        permissions: permissions([], ['idp:client-role:read']),
      }),
      requirement,
    );
    expect(result).toMatchObject({ ok: false, status: 403, error: 'insufficient_scope' });
  });

  it('rejects a delegated token without the client-admin scope', async () => {
    const result = await authorizeAdminRequest(
      request(tokenWith(delegatedToken)),
      guard({
        verifier: verifier({ ...delegatedToken, scope: 'openid profile' }),
        permissions: permissions([], ['idp:client-role:read']),
      }),
      requirement,
    );
    expect(result).toMatchObject({ ok: false, status: 403, error: 'insufficient_scope' });
  });

  it('rejects a delegated token on an operation outside idp:client-*', async () => {
    const result = await authorizeAdminRequest(
      request(tokenWith(delegatedToken)),
      guard({
        verifier: verifier(delegatedToken),
        permissions: permissions([], ['idp:role:read']),
      }),
      { permission: 'idp:role:read', clientId: 'app-a' },
    );
    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' });
  });

  it('accepts the client-scoped social provider permission', async () => {
    const result = await authorizeAdminRequest(
      request(tokenWith(delegatedToken)),
      guard({
        verifier: verifier(delegatedToken),
        permissions: permissions([], ['idp:social-provider:read']),
      }),
      { permission: 'idp:social-provider:read', clientId: 'app-a' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.mode).toBe('delegated');
      expect([...result.principal.permissions]).toEqual(['idp:social-provider:read']);
    }
  });

  it('rejects a delegated caller without the scoped permission', async () => {
    const result = await authorizeAdminRequest(
      request(tokenWith(delegatedToken)),
      guard({
        verifier: verifier(delegatedToken),
        permissions: permissions([], []),
      }),
      requirement,
    );
    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' });
  });

  it('very old delegation tokens cannot use the global admin surface', async () => {
    const result = await authorizeAdminRequest(
      request(tokenWith(delegatedToken)),
      guard({
        verifier: verifier(delegatedToken),
        permissions: permissions(['idp:user:read'], ['idp:client-role:read']),
      }),
      'idp:user:read',
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('requires a fresh authentication for step-up operations', async () => {
    const options = guard({
      verifier: verifier(delegatedToken),
      permissions: permissions([], ['idp:client-role:write']),
      now: () => new Date(1_760_000_100 * 1000),
    });
    const fresh = await authorizeAdminRequest(request(tokenWith(delegatedToken)), options, {
      ...requirement,
      delegatedPermission: 'idp:client-role:write',
      stepUp: true,
    });
    expect(fresh.ok).toBe(true);

    const stale = await authorizeAdminRequest(
      request(tokenWith(delegatedToken)),
      guard({
        verifier: verifier(delegatedToken),
        permissions: permissions([], ['idp:client-role:write']),
        now: () => new Date(1_760_000_000 * 1000 + 3_600_000),
      }),
      { ...requirement, delegatedPermission: 'idp:client-role:write', stepUp: true },
    );
    expect(stale).toMatchObject({
      ok: false,
      status: 403,
      error: 'insufficient_user_authentication',
    });
  });
});
