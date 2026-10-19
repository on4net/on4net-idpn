import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditViewer } from '@/admin/audit-viewer';
import { AdminApiError, type AdminApiClient, type AdminAuditEvent } from '@/admin/api-client';

const event = (overrides: Partial<AdminAuditEvent> = {}): AdminAuditEvent => ({
  id: 'event-1',
  occurredAt: '2026-10-19T08:00:00.000Z',
  actorType: 'admin',
  actorId: 'admin-1',
  action: 'user.update',
  targetType: 'user',
  targetId: 'user-2',
  clientId: 'admin-panel',
  ip: '127.0.0.1',
  userAgent: 'vitest',
  result: 'success',
  metadata: {},
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
    listUsers: vi.fn(async () => ({ items: [], page: 1, limit: 25, total: 0 })),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    disableUser: vi.fn(),
    enableUser: vi.fn(),
    unlockUser: vi.fn(),
    resetPassword: vi.fn(),
    listAuditEvents: vi.fn(async () => ({
      items: [
        event(),
        event({
          id: 'event-2',
          occurredAt: '2026-10-18T08:00:00.000Z',
          actorId: null,
          actorType: 'system',
          action: 'user.login.failed',
          clientId: null,
          result: 'failure',
        }),
      ],
      page: 1,
      limit: 25,
      total: 2,
    })),
    exportAuditEvents: vi.fn(async () => new Blob(['id,action\n'], { type: 'text/csv' })),
    ...overrides,
  } as AdminApiClient;
}

const clickSelect = async (label: string, option: string) => {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByLabelText(label));
  await user.click(await screen.findByRole('option', { name: option }));
};

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:audit'),
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuditViewer', () => {
  it('renders events in an accessible table with labelled filters in RTL', async () => {
    const client = fakeClient();
    render(<AuditViewer client={client} locale="fa-IR" />);

    expect(await screen.findByText('user.update')).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'زمان' })).toBeTruthy();
    expect(screen.getByLabelText('از تاریخ')).toBeTruthy();
    expect(screen.getByLabelText('شناسه کلاینت')).toBeTruthy();
    expect(client.listAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 25 }),
    );
    expect(screen.getByTestId('admin-audit-page')).toHaveTextContent('صفحه 1 از 1');
  });

  it('applies every filter and resets to the first page', async () => {
    const client = fakeClient();
    render(<AuditViewer client={client} locale="en-US" />);
    await screen.findByText('user.update');

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01T10:00' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-02T11:30' } });
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: ' user.update ' } });
    fireEvent.change(screen.getByLabelText('Actor ID'), {
      target: { value: ' 11111111-1111-4111-8111-111111111111 ' },
    });
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'app-a' } });
    fireEvent.change(screen.getByLabelText('Target type'), { target: { value: 'user' } });
    await clickSelect('Result', 'Failure');
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() =>
      expect(client.listAuditEvents).toHaveBeenLastCalledWith({
        page: 1,
        limit: 25,
        from: new Date('2026-10-01T10:00').toISOString(),
        to: new Date('2026-10-02T11:30').toISOString(),
        action: 'user.update',
        actorId: '11111111-1111-4111-8111-111111111111',
        clientId: 'app-a',
        targetType: 'user',
        result: 'failure',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() =>
      expect(client.listAuditEvents).toHaveBeenLastCalledWith({ page: 1, limit: 25 }),
    );
  });

  it('pages forward while keeping the applied filters', async () => {
    const listAuditEvents = vi.fn(async ({ page }: { page?: number }) => ({
      items: [event({ id: `event-${page ?? 1}` })],
      page: page ?? 1,
      limit: 25,
      total: 60,
    }));
    const client = fakeClient({ listAuditEvents });
    render(<AuditViewer client={client} locale="en-US" />);
    await screen.findByText('user.update');

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'user.update' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() =>
      expect(listAuditEvents).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, action: 'user.update' }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() =>
      expect(listAuditEvents).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2, action: 'user.update' }),
      ),
    );
    expect(screen.getByTestId('admin-audit-page')).toHaveTextContent('Page 2 of 3');
  });

  it('shows the empty state and a network error', async () => {
    const empty = fakeClient({
      listAuditEvents: vi.fn(async () => ({ items: [], page: 1, limit: 25, total: 0 })),
    });
    const { unmount } = render(<AuditViewer client={empty} locale="en-US" />);
    expect(await screen.findByTestId('admin-audit-empty')).toBeTruthy();
    unmount();

    const failing = fakeClient({
      listAuditEvents: vi.fn(async () => {
        throw new AdminApiError('network', 0, 'network error');
      }),
    });
    render(<AuditViewer client={failing} locale="en-US" />);
    expect(await screen.findByTestId('admin-audit-error')).toHaveTextContent(
      'Could not reach the server',
    );
    expect(screen.getByTestId('admin-audit-empty')).toBeTruthy();
  });

  it('downloads a CSV export with the applied filters', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const client = fakeClient();
    render(<AuditViewer client={client} locale="en-US" />);
    await screen.findByText('user.update');

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'user.update' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() =>
      expect(client.listAuditEvents).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'user.update' }),
      ),
    );

    fireEvent.click(screen.getByTestId('admin-audit-export'));

    await waitFor(() =>
      expect(client.exportAuditEvents).toHaveBeenCalledWith({
        format: 'csv',
        action: 'user.update',
      }),
    );
    expect(await screen.findByTestId('admin-audit-notice')).toHaveTextContent(
      'The export file is ready.',
    );
    expect(click).toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audit');
  });

  it('exports NDJSON when that format is selected', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const client = fakeClient();
    render(<AuditViewer client={client} locale="en-US" />);
    await screen.findByText('user.update');

    await clickSelect('Export format', 'NDJSON');
    fireEvent.click(screen.getByTestId('admin-audit-export'));

    await waitFor(() =>
      expect(client.exportAuditEvents).toHaveBeenCalledWith({ format: 'ndjson' }),
    );
  });

  it('surfaces a forbidden export without pretending it succeeded', async () => {
    const client = fakeClient({
      exportAuditEvents: vi.fn(async () => {
        throw new AdminApiError('forbidden', 403, 'Forbidden');
      }),
    });
    render(<AuditViewer client={client} locale="en-US" />);
    await screen.findByText('user.update');

    fireEvent.click(screen.getByTestId('admin-audit-export'));

    expect(await screen.findByTestId('admin-audit-error')).toHaveTextContent(
      'do not have the permission',
    );
  });

  it('does not call the API when the admin is signed out', () => {
    const client = fakeClient();
    render(<AuditViewer client={client} locale="fa-IR" signedOut />);

    expect(screen.getByTestId('admin-audit-signed-out')).toBeTruthy();
    expect(client.listAuditEvents).not.toHaveBeenCalled();
    expect(screen.getByTestId('admin-audit-export')).toBeDisabled();
  });
});
