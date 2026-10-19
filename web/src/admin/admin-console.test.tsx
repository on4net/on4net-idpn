import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AdminConsole } from '@/admin/admin-console';
import { adminErrorMessage } from '@/admin/error-message';
import {
  AdminApiError,
  createAdminApiClient,
  type AdminApiClient,
  type AdminSession,
  type AdminUser,
} from '@/admin/api-client';

const user = (overrides: Partial<AdminUser> = {}): AdminUser => ({
  id: 'user-1',
  username: 'ali',
  email: 'ali@example.com',
  displayName: 'Ali Rezaei',
  phone: null,
  locale: 'fa-IR',
  status: 'active',
  emailVerified: false,
  mustChangePassword: false,
  lockedUntil: null,
  lastLoginAt: null,
  createdAt: '2026-10-19T08:00:00.000Z',
  updatedAt: '2026-10-19T08:00:00.000Z',
  ...overrides,
});

const session = (overrides: Partial<AdminSession> = {}): AdminSession => ({
  id: 'session-1',
  userId: 'user-1',
  clientId: 'app-a',
  status: 'active',
  createdAt: '2026-10-19T08:00:00.000Z',
  lastSeenAt: '2026-10-19T08:05:00.000Z',
  idleExpiresAt: '2026-10-19T08:35:00.000Z',
  absoluteExpiresAt: '2026-10-19T20:00:00.000Z',
  ip: '10.0.0.1',
  userAgent: 'vitest-agent',
  amr: ['pwd'],
  acr: 'urn:on4net:acr:pwd',
  revokedAt: null,
  revokeReason: null,
  ...overrides,
});

function fakeClient(overrides: Partial<AdminApiClient> = {}): AdminApiClient {
  return {
    me: vi.fn(async () => ({
      id: 'admin-1',
      clientId: 'admin-panel',
      scopes: [],
      permissions: [],
    })),
    listUsers: vi.fn(async () => ({ items: [user()], page: 1, limit: 25, total: 1 })),
    createUser: vi.fn(async () => ({ user: user(), revokedSessions: 0 })),
    updateUser: vi.fn(async () => user()),
    disableUser: vi.fn(async () => ({ user: user({ status: 'disabled' }), revokedSessions: 1 })),
    enableUser: vi.fn(async () => ({ user: user(), revokedSessions: 0 })),
    unlockUser: vi.fn(async () => ({ user: user(), revokedSessions: 0 })),
    resetPassword: vi.fn(async () => ({
      user: user(),
      revokedSessions: 1,
      temporaryPassword: 'tmp-123',
    })),
    listSessions: vi.fn(async () => ({
      items: [session()],
      page: 1,
      limit: 25,
      total: 1,
    })),
    revokeSession: vi.fn(async () => ({ revoked: true, alreadyRevoked: false })),
    listAuditEvents: vi.fn(async () => ({ items: [], page: 1, limit: 25, total: 0 })),
    exportAuditEvents: vi.fn(async () => new Blob([''], { type: 'text/csv' })),
    ...overrides,
  };
}

describe('AdminConsole', () => {
  it('renders the user list in Persian RTL with an accessible table', async () => {
    const client = fakeClient();
    render(<AdminConsole client={client} locale="fa-IR" />);

    expect(await screen.findByText('Ali Rezaei')).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'وضعیت' })).toBeTruthy();
    expect(screen.getByLabelText('جست‌وجو')).toBeTruthy();
    expect(client.listUsers).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 25, sort: 'createdAt:desc' }),
    );
  });

  it('provides direction to Radix and to the portalled dialog in RTL', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    render(<AdminConsole client={client} locale="fa-IR" />);

    await screen.findByText('Ali Rezaei');
    const consoleRoot = screen.getByTestId('admin-console');
    expect(consoleRoot).toHaveAttribute('dir', 'rtl');

    const email = screen.getByText('ali@example.com');
    expect(email.tagName).toBe('BDI');
    expect(email).toHaveAttribute('dir', 'ltr');

    await user.click(screen.getByRole('button', { name: 'کاربر جدید' }));
    const dialog = await screen.findByRole('dialog', { name: 'کاربر جدید' });
    expect(dialog.closest('[dir]')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByLabelText('ایمیل')).toHaveAttribute('dir', 'ltr');
  });

  it('searches with the typed query and resets to the first page', async () => {
    const client = fakeClient();
    render(<AdminConsole client={client} locale="en-US" />);
    await screen.findByText('Ali Rezaei');

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '  ali  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() =>
      expect(client.listUsers).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'ali', page: 1 }),
      ),
    );
  });

  it('disables a user and refreshes the list', async () => {
    const client = fakeClient();
    render(<AdminConsole client={client} locale="en-US" />);
    await screen.findByText('Ali Rezaei');

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

    await waitFor(() => expect(client.disableUser).toHaveBeenCalledWith('user-1'));
    expect(await screen.findByTestId('admin-notice')).toHaveTextContent('ali@example.com');
    expect(client.listUsers).toHaveBeenCalledTimes(2);
  });

  it('shows an enabled action for a disabled user', async () => {
    const client = fakeClient({
      listUsers: vi.fn(async () => ({
        items: [user({ status: 'disabled' })],
        page: 1,
        limit: 25,
        total: 1,
      })),
    });
    render(<AdminConsole client={client} locale="en-US" />);
    await screen.findByText('Ali Rezaei');

    expect(screen.getByText('Disabled')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(client.enableUser).toHaveBeenCalledWith('user-1'));
  });

  it('shows the one-time temporary password after a reset', async () => {
    const client = fakeClient();
    render(<AdminConsole client={client} locale="en-US" />);
    await screen.findByText('Ali Rezaei');

    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    const alert = await screen.findByTestId('admin-temp-password');
    expect(within(alert).getByText('tmp-123')).toBeTruthy();
  });

  it('creates a user from the dialog', async () => {
    const client = fakeClient({
      createUser: vi.fn(async () => ({
        user: user({ username: 'sara' }),
        revokedSessions: 0,
        temporaryPassword: 'tmp-456',
      })),
    });
    render(<AdminConsole client={client} locale="en-US" />);
    await screen.findByText('Ali Rezaei');

    fireEvent.click(screen.getByRole('button', { name: 'New user' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'sara' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sara@example.com' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Sara' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(client.createUser).toHaveBeenCalledWith({
        username: 'sara',
        email: 'sara@example.com',
        displayName: 'Sara',
        locale: 'en-US',
      }),
    );
    expect(await screen.findByText('tmp-456')).toBeTruthy();
    // The dialog has no Radix trigger; focus still returns to the button that opened it.
    expect(screen.getByRole('button', { name: 'New user' })).toHaveFocus();
  });

  it('reports a forbidden action without changing the table', async () => {
    const client = fakeClient({
      disableUser: vi.fn(async () => {
        throw new AdminApiError('forbidden', 403, 'Forbidden');
      }),
    });
    render(<AdminConsole client={client} locale="en-US" />);
    await screen.findByText('Ali Rezaei');

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

    const error = await screen.findByTestId('admin-error');
    expect(error).toHaveTextContent('do not have the permission');
    expect(client.listUsers).toHaveBeenCalledTimes(1);
  });

  it('explains that admin sign-in is required when no token is available', () => {
    const client = fakeClient();
    render(<AdminConsole client={client} locale="fa-IR" signedOut />);

    expect(screen.getByTestId('admin-signed-out')).toBeTruthy();
    expect(client.listUsers).not.toHaveBeenCalled();
  });

  it('switches to the audit tab and loads audit events only then', async () => {
    const client = fakeClient();
    render(<AdminConsole client={client} locale="en-US" />);
    await screen.findByText('Ali Rezaei');

    expect(client.listAuditEvents).not.toHaveBeenCalled();
    await userEvent
      .setup({ pointerEventsCheck: 0 })
      .click(screen.getByRole('tab', { name: 'Audit' }));

    expect(await screen.findByTestId('admin-audit-viewer')).toBeTruthy();
    await waitFor(() =>
      expect(client.listAuditEvents).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, limit: 25 }),
      ),
    );
    expect(await screen.findByTestId('admin-audit-empty')).toBeTruthy();
  });

  it('lists sessions with filters and revokes one from the sessions tab', async () => {
    const client = fakeClient();
    render(<AdminConsole client={client} locale="en-US" />);
    await screen.findByText('Ali Rezaei');
    expect(client.listSessions).not.toHaveBeenCalled();

    await userEvent
      .setup({ pointerEventsCheck: 0 })
      .click(screen.getByRole('tab', { name: 'Sessions' }));

    expect(await screen.findByTestId('session-row-session-1')).toBeTruthy();
    expect(client.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 25 }),
    );

    fireEvent.change(screen.getByLabelText('User ID'), { target: { value: ' user-1 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() =>
      expect(client.listSessions).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: 'user-1', page: 1 }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Revoke session session-1' }));
    await waitFor(() => expect(client.revokeSession).toHaveBeenCalledWith('session-1'));
    expect(await screen.findByTestId('sessions-notice')).toHaveTextContent('session-1');
  });

  it('shows empty and error states for sessions', async () => {
    const empty = fakeClient({
      listSessions: vi.fn(async () => ({ items: [], page: 1, limit: 25, total: 0 })),
    });
    const { unmount } = render(<AdminConsole client={empty} locale="fa-IR" />);
    await screen.findByText('Ali Rezaei');
    await userEvent
      .setup({ pointerEventsCheck: 0 })
      .click(screen.getByRole('tab', { name: 'نشست‌ها' }));
    expect(await screen.findByTestId('sessions-empty')).toHaveTextContent('نشستی یافت نشد');
    expect(screen.getByLabelText('شناسه کاربر')).toBeTruthy();
    unmount();

    const failing = fakeClient({
      listSessions: vi.fn(async () => {
        throw new AdminApiError('forbidden', 403, 'Forbidden');
      }),
    });
    render(<AdminConsole client={failing} locale="en-US" />);
    await screen.findByText('Ali Rezaei');
    await userEvent
      .setup({ pointerEventsCheck: 0 })
      .click(screen.getByRole('tab', { name: 'Sessions' }));
    expect(await screen.findByTestId('sessions-error')).toHaveTextContent(
      'do not have the permission',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('pages forward when more users exist', async () => {
    const listUsers = vi.fn(async ({ page }: { page?: number }) => ({
      items: [
        user({
          id: `user-${page ?? 1}`,
          username: `u${page ?? 1}`,
          displayName: `User ${page ?? 1}`,
        }),
      ],
      page: page ?? 1,
      limit: 25,
      total: 60,
    }));
    render(<AdminConsole client={fakeClient({ listUsers })} locale="en-US" />);
    await screen.findByText('User 1');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByText('User 2');
    expect(screen.getByTestId('admin-page')).toHaveTextContent('Page 2 of 3');
  });
});

describe('createAdminApiClient', () => {
  const jsonFetch = (status: number, body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

  it('fails fast without a token', async () => {
    const client = createAdminApiClient({ getToken: () => null });
    await expect(client.listUsers()).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
  });

  it('sends the bearer token and parses the paginated response', async () => {
    const fetchImpl = vi.fn(jsonFetch(200, { items: [], page: 2, limit: 25, total: 0 }));
    const client = createAdminApiClient({
      getToken: () => 'token-abc',
      baseUrl: 'https://api.example.com/',
      fetchImpl,
    });

    await expect(
      client.listUsers({ page: 2, limit: 25, q: 'ali', status: 'active', sort: 'email:asc' }),
    ).resolves.toMatchObject({ page: 2 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://api.example.com/api/v1/users?page=2&limit=25&q=ali&status=active&sort=email%3Aasc',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-abc');
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('lists sessions with filters and revokes the selected session', async () => {
    const fetchImpl = vi.fn(jsonFetch(200, { items: [session()], page: 1, limit: 25, total: 1 }));
    const client = createAdminApiClient({ getToken: () => 'token', fetchImpl });

    await client.listSessions({
      page: 1,
      limit: 25,
      userId: 'user-1',
      clientId: 'app-a',
      status: 'active',
    });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      '/api/v1/sessions?page=1&limit=25&userId=user-1&clientId=app-a&status=active',
    );

    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ revoked: true, alreadyRevoked: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(client.revokeSession('session/1')).resolves.toMatchObject({ revoked: true });
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toBe(
      '/api/v1/sessions/session%2F1',
    );
  });

  it('omits the query string when no parameters are given', async () => {
    const fetchImpl = vi.fn(jsonFetch(200, { items: [], page: 1, limit: 25, total: 0 }));
    const client = createAdminApiClient({ getToken: () => 't', fetchImpl });
    await client.listUsers({ q: '' });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('/api/v1/users');
  });

  it('maps an RFC 9457 problem to a typed error', async () => {
    const client = createAdminApiClient({
      getToken: () => 'token',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail: 'permission idp:user:write is required',
          }),
          { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
        )) as unknown as typeof fetch,
    });

    await expect(client.disableUser('user-1')).rejects.toMatchObject({
      kind: 'forbidden',
      status: 403,
      detail: 'permission idp:user:write is required',
    });
  });

  it.each([
    [401, 'unauthorized'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'invalid'],
    [500, 'server'],
  ] as const)('maps status %i to %s', async (status, kind) => {
    const client = createAdminApiClient({
      getToken: () => 'token',
      fetchImpl: jsonFetch(status, { title: 'Problem' }),
    });
    await expect(client.unlockUser('user-1')).rejects.toMatchObject({ kind, status });
  });

  it('falls back to a generic title when the problem body is empty', async () => {
    const client = createAdminApiClient({
      getToken: () => 'token',
      fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
    });
    await expect(client.me()).rejects.toMatchObject({ kind: 'server', message: 'request failed' });
  });

  it('creates a user with and without a temporary password', async () => {
    const withoutTemp = createAdminApiClient({
      getToken: () => 't',
      fetchImpl: jsonFetch(201, { user: user() }),
    });
    await expect(
      withoutTemp.createUser({ username: 'ali', email: 'ali@example.com', displayName: 'Ali' }),
    ).resolves.toEqual({ user: user(), revokedSessions: 0 });

    const withTemp = createAdminApiClient({
      getToken: () => 't',
      fetchImpl: jsonFetch(201, { user: user(), temporaryPassword: 'tmp-1' }),
    });
    await expect(
      withTemp.createUser({ username: 'ali', email: 'ali@example.com', displayName: 'Ali' }),
    ).resolves.toMatchObject({ temporaryPassword: 'tmp-1' });
  });

  it('sends an explicit password on reset only when one is provided', async () => {
    const fetchImpl = vi.fn(jsonFetch(200, { user: user(), revokedSessions: 0 }));
    const client = createAdminApiClient({ getToken: () => 't', fetchImpl });

    await client.resetPassword('user-1');
    await client.resetPassword('user-1', 'a-long-enough-password');

    const first = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const second = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(first[0]).toBe('/api/v1/users/user-1/reset-password');
    expect(first[1].body).toBe('{}');
    expect(second[1].body).toBe(JSON.stringify({ password: 'a-long-enough-password' }));
  });

  it('updates a user through PATCH', async () => {
    const fetchImpl = vi.fn(jsonFetch(200, user({ displayName: 'Ali R.' })));
    const client = createAdminApiClient({ getToken: () => 't', fetchImpl });
    await expect(client.updateUser('user-1', { displayName: 'Ali R.' })).resolves.toMatchObject({
      displayName: 'Ali R.',
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PATCH');
  });

  it('reports a network failure as a typed error', async () => {
    const client = createAdminApiClient({
      getToken: () => 'token',
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    await expect(client.me()).rejects.toMatchObject({ kind: 'network' });
  });

  it('lists audit events with every filter in the query string', async () => {
    const fetchImpl = vi.fn(jsonFetch(200, { items: [], page: 2, limit: 50, total: 0 }));
    const client = createAdminApiClient({
      getToken: () => 'token',
      baseUrl: 'https://api.example.com',
      fetchImpl,
    });

    await client.listAuditEvents({
      page: 2,
      limit: 50,
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      action: 'user.login.failed',
      actorId: '11111111-1111-4111-8111-111111111111',
      clientId: 'app-a',
      targetType: 'user',
      result: 'failure',
    });

    const url = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0], 'https://base');
    expect(url.pathname).toBe('/api/v1/audit-events');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      action: 'user.login.failed',
      actorId: '11111111-1111-4111-8111-111111111111',
      clientId: 'app-a',
      targetType: 'user',
      result: 'failure',
      page: '2',
      limit: '50',
    });
  });

  it('omits empty audit filters from the query string', async () => {
    const fetchImpl = vi.fn(jsonFetch(200, { items: [], page: 1, limit: 25, total: 0 }));
    const client = createAdminApiClient({ getToken: () => 't', fetchImpl });
    await client.listAuditEvents({
      from: '',
      to: '',
      action: '',
      actorId: '',
      clientId: '',
      targetType: '',
    });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('/api/v1/audit-events');
  });

  it('downloads an audit export as a blob with the bearer token', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('id,action\n', {
          status: 200,
          headers: { 'Content-Type': 'text/csv' },
        }),
    );
    const client = createAdminApiClient({ getToken: () => 'token-abc', fetchImpl });

    const blob = await client.exportAuditEvents({ format: 'csv', action: 'user.update' });

    expect(blob.size).toBeGreaterThan(0);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/audit-events/export?action=user.update&format=csv');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-abc');
    expect(headers.Accept).toBe('text/csv');
  });

  it('requests NDJSON exports with the matching accept header', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{}\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }),
    );
    const client = createAdminApiClient({ getToken: () => 't', fetchImpl });
    await client.exportAuditEvents({ format: 'ndjson' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/audit-events/export?format=ndjson');
    expect((init.headers as Record<string, string>).Accept).toBe('application/x-ndjson');
  });

  it('maps a forbidden export to a typed error', async () => {
    const client = createAdminApiClient({
      getToken: () => 't',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ title: 'Forbidden', detail: 'permission idp:audit:export is required' }),
          { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
        )) as unknown as typeof fetch,
    });

    await expect(client.exportAuditEvents({ format: 'csv' })).rejects.toMatchObject({
      kind: 'forbidden',
      status: 403,
      detail: 'permission idp:audit:export is required',
    });
  });

  it('rejects an export without a token or when the network fails', async () => {
    await expect(
      createAdminApiClient({ getToken: () => null }).exportAuditEvents({ format: 'csv' }),
    ).rejects.toMatchObject({ kind: 'unauthorized' });

    const offline = createAdminApiClient({
      getToken: () => 't',
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    await expect(offline.exportAuditEvents({ format: 'csv' })).rejects.toMatchObject({
      kind: 'network',
    });
  });
});

describe('AdminConsole edge states', () => {
  it('reports a list failure and keeps the table empty', async () => {
    const client = fakeClient({
      listUsers: vi.fn(async () => {
        throw new AdminApiError('network', 0, 'network error');
      }),
    });
    render(<AdminConsole client={client} locale="en-US" />);

    expect(await screen.findByTestId('admin-error')).toHaveTextContent(
      'Could not reach the server',
    );
    expect(screen.getByTestId('admin-empty')).toBeTruthy();
  });

  it('renders every status badge and disables paging on a single page', async () => {
    const client = fakeClient({
      listUsers: vi.fn(async () => ({
        items: [
          user({ id: 'a', username: 'a', status: 'active' }),
          user({ id: 'b', username: 'b', status: 'pending' }),
          user({ id: 'c', username: 'c', status: 'locked' }),
        ],
        page: 1,
        limit: 25,
        total: 3,
      })),
    });
    render(<AdminConsole client={client} locale="en-US" />);
    await screen.findByText('Active');

    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.getByText('Locked')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});

describe('adminErrorMessage', () => {
  it('prefers the problem detail for non-auth API errors', () => {
    expect(adminErrorMessage(new AdminApiError('invalid', 422, 'Bad', 'bad detail'), 'en-US')).toBe(
      'bad detail',
    );
    expect(adminErrorMessage(new Error('boom'), 'en-US')).toBe('An unexpected error occurred.');
  });
});

describe('mountAdminConsole', () => {
  it('renders the console into the element with the locale direction', async () => {
    const { mountAdminConsole } = await import('@/admin/mount');
    const element = document.createElement('div');
    document.body.append(element);

    const root = mountAdminConsole(element, {
      getToken: () => 'token',
      locale: 'fa-IR',
      pageSize: 10,
    });

    expect(element.getAttribute('dir')).toBe('rtl');
    await waitFor(() =>
      expect(element.querySelector('[data-testid="admin-console"]')).not.toBeNull(),
    );
    root.unmount();
    element.remove();
  });
});
