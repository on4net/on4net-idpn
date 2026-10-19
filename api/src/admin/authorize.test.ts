import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { authorizeAdminRequest, readBearerToken, type AdminGuardOptions } from './authorize.js';

const issuer = 'https://auth.example.com';

const request = (authorization?: string): FastifyRequest =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as FastifyRequest;

const permissions = (held: string[]) => ({
  async globalPermissionsForUser(): Promise<string[]> {
    return held;
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
