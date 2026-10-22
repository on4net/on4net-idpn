import { describe, expect, it, vi } from 'vitest';

import { MfeApiError, createMfeApiClient } from './api-client';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const fetchMock = (response: Response) =>
  vi.fn().mockResolvedValue(response) as unknown as typeof fetch & {
    mock: { calls: [string, RequestInit?][] };
  };

describe('createMfeApiClient', () => {
  it('lists members with the client-scoped URL and cookie credentials', async () => {
    const response = jsonResponse({ items: [], page: 2, limit: 10, total: 0 });
    const fetchImpl = fetchMock(response);
    const client = createMfeApiClient({
      clientId: 'app-a',
      baseUrl: 'https://bff.example/',
      fetchImpl,
    });

    await client.listMembers({ page: 2, limit: 10, q: 'ali', status: 'active' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bff.example/api/v1/clients/app-a/members?page=2&limit=10&q=ali&status=active',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('adds an in-memory token only when the host provides one', async () => {
    const fetchImpl = fetchMock(jsonResponse({ items: [], page: 1, limit: 10, total: 0 }));
    const client = createMfeApiClient({
      clientId: 'app-a',
      getAccessToken: () => 'token-1',
      fetchImpl,
    });

    await client.listMembers();
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      ['Bearer', 'token-1'].join(' '),
    );

    const anonymousFetch = fetchMock(jsonResponse({ items: [], page: 1, limit: 10, total: 0 }));
    await createMfeApiClient({
      clientId: 'app-a',
      getAccessToken: () => '',
      fetchImpl: anonymousFetch,
    }).listMembers();
    const anonymousInit = anonymousFetch.mock.calls[0]?.[1] as RequestInit;
    expect((anonymousInit.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('loads the role catalog of the same client', async () => {
    const fetchImpl = fetchMock(
      jsonResponse({ items: [{ id: 'r1', key: 'app-a:member', name: 'Member' }] }),
    );
    const client = createMfeApiClient({ clientId: 'app-a', fetchImpl });

    const roles = await client.listRoles();

    expect(roles).toHaveLength(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/roles?clientId=app-a&limit=100');
  });

  it('invites an existing member', async () => {
    const fetchImpl = fetchMock(
      jsonResponse({ member: { userId: 'u1' }, createdUser: false }, 201),
    );
    const client = createMfeApiClient({ clientId: 'app-a', fetchImpl });

    await client.inviteMember({
      email: 'new@example.com',
      roleKeys: ['app-a:member'],
      attributes: { department: 'sales' },
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/clients/app-a/members/invite');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'new@example.com',
      roleKeys: ['app-a:member'],
      attributes: { department: 'sales' },
    });
  });

  it('updates membership status and replaces roles', async () => {
    const fetchImpl = fetchMock(jsonResponse({ userId: 'u1' }));
    const client = createMfeApiClient({ clientId: 'app-a', fetchImpl });

    await client.updateMember('u1', { status: 'suspended' });
    await client.replaceRoles('u1', ['app-a:editor']);

    const [patchUrl, patchInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(patchUrl).toBe('/api/v1/clients/app-a/members/u1');
    expect(patchInit.method).toBe('PATCH');
    expect(JSON.parse(String(patchInit.body))).toEqual({ status: 'suspended' });

    const [putUrl, putInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(putUrl).toBe('/api/v1/clients/app-a/members/u1/roles');
    expect(putInit.method).toBe('PUT');
    expect(JSON.parse(String(putInit.body))).toEqual({ roleKeys: ['app-a:editor'] });
  });

  it('maps problem responses to typed errors', async () => {
    const cases = [
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [422, 'invalid'],
      [500, 'server'],
    ] as const;

    for (const [status, kind] of cases) {
      const fetchImpl = fetchMock(jsonResponse({ title: 'Failure', detail: 'reason' }, status));
      const client = createMfeApiClient({ clientId: 'app-a', fetchImpl });
      await expect(client.listMembers()).rejects.toMatchObject({ kind, status, detail: 'reason' });
    }
  });

  it('reports network failures and non-JSON bodies', async () => {
    const failing = vi.fn().mockRejectedValue(new TypeError('failed')) as unknown as typeof fetch;
    await expect(
      createMfeApiClient({ clientId: 'app-a', fetchImpl: failing }).listMembers(),
    ).rejects.toMatchObject({ kind: 'network', status: 0 });

    const empty = vi
      .fn()
      .mockResolvedValue(new Response('not-json', { status: 502 })) as unknown as typeof fetch;
    await expect(
      createMfeApiClient({ clientId: 'app-a', fetchImpl: empty }).listMembers(),
    ).rejects.toMatchObject({ kind: 'server', status: 502, message: 'request failed' });
  });

  it('propagates abort errors instead of treating them as network failures', async () => {
    const aborted = new DOMException('aborted', 'AbortError');
    const fetchImpl = vi.fn().mockRejectedValue(aborted) as unknown as typeof fetch;
    const client = createMfeApiClient({ clientId: 'app-a', fetchImpl });

    await expect(client.listMembers()).rejects.toBe(aborted);
  });

  it('is an MfeApiError instance', () => {
    const error = new MfeApiError('invalid', 422, 'Validation', 'bad field');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MfeApiError');
    expect(error.detail).toBe('bad field');
  });
});
