import { describe, expect, it, vi } from 'vitest';

import { AccountApiError, createAccountApiClient } from './account-api-client';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

type FetchMock = typeof fetch & { mock: { calls: [string, RequestInit?][] } };

const fetchMock = (response: Response | (() => Promise<Response>)): FetchMock =>
  vi.fn(
    typeof response === 'function' ? response : () => Promise.resolve(response),
  ) as unknown as FetchMock;

const profile = {
  id: 'u1',
  username: 'sara',
  email: 'sara@example.com',
  displayName: 'Sara',
  phone: null,
  avatarUrl: null,
  locale: 'fa-IR',
  status: 'active',
  emailVerified: true,
  mustChangePassword: false,
  createdAt: '2026-10-19T09:00:00.000Z',
  passwordChangedAt: null,
};

describe('createAccountApiClient', () => {
  it('loads the profile with cookie credentials and no token header', async () => {
    const fetchImpl = fetchMock(jsonResponse(profile));
    const client = createAccountApiClient({
      baseUrl: 'https://auth.example/',
      fetchImpl,
    });

    await expect(client.getProfile()).resolves.toEqual(profile);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://auth.example/api/v1/account/profile',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('sends the password change as a JSON PUT', async () => {
    const fetchImpl = fetchMock(
      jsonResponse({
        ok: true,
        revokedSessions: 1,
        revokedRefreshTokens: 2,
        keptCurrentSession: true,
      }),
    );
    const client = createAccountApiClient({ fetchImpl });

    await client.changePassword({
      currentPassword: 'old-password-1',
      newPassword: 'new-password-12',
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/account/password');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      currentPassword: 'old-password-1',
      newPassword: 'new-password-12',
    });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('lists only the requested page of sessions', async () => {
    const fetchImpl = fetchMock(jsonResponse({ items: [], page: 2, limit: 10, total: 0 }));
    const client = createAccountApiClient({ fetchImpl });

    await client.listSessions({ page: 2, limit: 10 });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/account/sessions?page=2&limit=10');
  });

  it('closes a session with an encoded id', async () => {
    const fetchImpl = fetchMock(jsonResponse({ revoked: true, alreadyRevoked: false }));
    const client = createAccountApiClient({ fetchImpl });

    await expect(client.closeSession('a/b')).resolves.toEqual({
      revoked: true,
      alreadyRevoked: false,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/account/sessions/a%2Fb');
  });

  it('exposes the problem code and password policy violations', async () => {
    const fetchImpl = fetchMock(
      jsonResponse(
        {
          title: 'Password policy violated',
          detail: 'the new password does not meet the password policy',
          code: 'password_policy',
          violations: ['too_short', 'common_password', 42],
        },
        422,
      ),
    );
    const client = createAccountApiClient({ fetchImpl });

    const error = await client
      .changePassword({ currentPassword: 'a', newPassword: 'b' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AccountApiError);
    const apiError = error as AccountApiError;
    expect(apiError.kind).toBe('invalid');
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe('password_policy');
    expect(apiError.violations).toEqual(['too_short', 'common_password']);
    expect(apiError.detail).toContain('password policy');
  });

  it('maps statuses to error kinds and tolerates a non-JSON problem body', async () => {
    const statuses: [number, string][] = [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [500, 'server'],
    ];
    for (const [status, kind] of statuses) {
      const fetchImpl = fetchMock(
        new Response('nope', { status, headers: { 'Content-Type': 'text/plain' } }),
      );
      const client = createAccountApiClient({ fetchImpl });
      const error = (await client
        .getProfile()
        .catch((caught: unknown) => caught)) as AccountApiError;
      expect(error).toBeInstanceOf(AccountApiError);
      expect(error.kind).toBe(kind);
      expect(error.status).toBe(status);
      expect(error.code).toBeUndefined();
    }
  });

  it('never treats an HTML host fallback as a profile', async () => {
    const fetchImpl = fetchMock(
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const client = createAccountApiClient({ fetchImpl });

    await expect(client.getProfile()).rejects.toMatchObject({ kind: 'server', status: 200 });
  });

  it('reports network failures as a network error', async () => {
    const fetchImpl = fetchMock(() => Promise.reject(new TypeError('offline')));
    const client = createAccountApiClient({ fetchImpl });

    await expect(client.getProfile()).rejects.toMatchObject({ kind: 'network', status: 0 });
  });

  it('re-throws an abort so unmounted components do not report an error', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const fetchImpl = fetchMock(() => Promise.reject(abort));
    const client = createAccountApiClient({ fetchImpl });

    await expect(client.getProfile()).rejects.toBe(abort);
  });
});
