import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { IdpnRoot } from '@/app/idpn-root';
import {
  MfeApiError,
  type MfeApiClient,
  type MfeMember,
  type MfeMemberPage,
  type MfeRole,
} from './api-client';
import { UserManagement } from './user-management';

const members: MfeMember[] = [
  {
    membershipId: 'm1',
    userId: 'u1',
    email: 'sara@example.com',
    username: 'sara',
    displayName: 'سارا محمدی',
    userStatus: 'active',
    status: 'active',
    attributes: {},
    roleKeys: ['app-a:member'],
    invitedAt: null,
    joinedAt: '2026-10-19T09:00:00.000Z',
    createdAt: '2026-10-19T09:00:00.000Z',
    updatedAt: '2026-10-19T09:00:00.000Z',
  },
  {
    membershipId: 'm2',
    userId: 'u2',
    email: 'ali@example.com',
    username: 'ali',
    displayName: 'علی رضایی',
    userStatus: 'pending',
    status: 'invited',
    attributes: {},
    roleKeys: [],
    invitedAt: '2026-10-19T09:00:00.000Z',
    joinedAt: null,
    createdAt: '2026-10-19T09:00:00.000Z',
    updatedAt: '2026-10-19T09:00:00.000Z',
  },
];

const roles: MfeRole[] = [
  {
    id: 'r1',
    key: 'app-a:member',
    name: 'عضو',
    description: 'default',
    isDefault: true,
  },
  {
    id: 'r2',
    key: 'app-a:editor',
    name: 'ویرایشگر',
    description: 'editor',
    isDefault: false,
  },
];

const pageOf = (items: MfeMember[], total = items.length): MfeMemberPage => ({
  items,
  page: 1,
  limit: 10,
  total,
});

interface FakeClient {
  client: MfeApiClient;
  listMembers: ReturnType<typeof vi.fn>;
  listRoles: ReturnType<typeof vi.fn>;
  inviteMember: ReturnType<typeof vi.fn>;
  updateMember: ReturnType<typeof vi.fn>;
  replaceRoles: ReturnType<typeof vi.fn>;
}

function fakeClient(overrides: Partial<Record<keyof MfeApiClient, unknown>> = {}): FakeClient {
  const listMembers = vi.fn().mockResolvedValue(pageOf(members));
  const listRoles = vi.fn().mockResolvedValue(roles);
  const inviteMember = vi.fn().mockResolvedValue({ member: members[1], createdUser: false });
  const updateMember = vi.fn().mockResolvedValue(members[0]);
  const replaceRoles = vi.fn().mockResolvedValue(members[0]);

  const client = {
    listMembers,
    listRoles,
    inviteMember,
    updateMember,
    replaceRoles,
    ...overrides,
  } as unknown as MfeApiClient;

  return { client, listMembers, listRoles, inviteMember, updateMember, replaceRoles };
}

function renderModule(
  client: MfeApiClient,
  onEvent?: (event: { type: string; code: string }) => void,
) {
  return render(
    <IdpnRoot locale="fa-IR" dir="rtl">
      <UserManagement
        clientId="app-a"
        apiClient={client}
        {...(onEvent === undefined ? {} : { onEvent })}
      />
    </IdpnRoot>,
  );
}

describe('UserManagement MFE module', () => {
  it('renders the members of the configured client', async () => {
    const { client, listMembers, listRoles } = fakeClient();
    renderModule(client);

    expect(await screen.findByText('سارا محمدی')).toBeInTheDocument();
    expect(screen.getByText('علی رضایی')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('فعال')).toBeInTheDocument();
    expect(within(table).getByText('دعوت‌شده')).toBeInTheDocument();

    const root = document.querySelector('[data-client-id="app-a"]');
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute('dir', 'rtl');
    expect(root).toHaveAttribute('lang', 'fa-IR');

    expect(listMembers).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 10 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(listRoles).toHaveBeenCalled();
  });

  it('shows an empty state when the app has no members', async () => {
    const { client } = fakeClient({ listMembers: vi.fn().mockResolvedValue(pageOf([])) });
    renderModule(client);

    expect(await screen.findByText('کاربری یافت نشد.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error, emits a token-free event and retries', async () => {
    const user = userEvent.setup();
    const listMembers = vi
      .fn()
      .mockRejectedValueOnce(new MfeApiError('forbidden', 403, 'Forbidden'))
      .mockResolvedValue(pageOf(members));
    const { client } = fakeClient({ listMembers });
    const onEvent = vi.fn();

    renderModule(client, onEvent);

    expect(await screen.findByText('دسترسی به مدیریت اعضای این اپ مجاز نیست.')).toBeInTheDocument();
    expect(onEvent).toHaveBeenCalledWith({ type: 'auth:error', code: 'forbidden' });
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain('secret-token');

    await user.click(screen.getByRole('button', { name: 'تلاش دوباره' }));
    expect(await screen.findByText('سارا محمدی')).toBeInTheDocument();
    expect(listMembers).toHaveBeenCalledTimes(2);
  });

  it('searches members and resets to the first page', async () => {
    const user = userEvent.setup();
    const { client, listMembers } = fakeClient();
    renderModule(client);

    await screen.findByText('سارا محمدی');
    await user.type(screen.getByLabelText('جست‌وجو'), 'ali');
    await user.click(screen.getByRole('button', { name: 'جست‌وجو' }));

    await waitFor(() =>
      expect(listMembers).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'ali', page: 1 }),
        expect.anything(),
      ),
    );
  });

  it('filters by membership status', async () => {
    const user = userEvent.setup();
    const { client, listMembers } = fakeClient();
    renderModule(client);

    await screen.findByText('سارا محمدی');
    await user.click(screen.getByRole('combobox', { name: 'وضعیت عضویت' }));
    await user.click(await screen.findByRole('option', { name: 'معلق' }));

    await waitFor(() =>
      expect(listMembers).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'suspended' }),
        expect.anything(),
      ),
    );
  });

  it('invites a member with the selected app role and attributes', async () => {
    const user = userEvent.setup();
    const { client, inviteMember, listMembers } = fakeClient();
    renderModule(client);

    await screen.findByText('سارا محمدی');
    await user.click(screen.getByRole('button', { name: 'دعوت کاربر' }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('ایمیل'), 'new@example.com');
    await user.type(within(dialog).getByLabelText('نام نمایشی (اختیاری)'), 'New User');
    await user.click(within(dialog).getByRole('button', { name: 'ویرایشگر' }));
    const attributesInput = within(dialog).getByLabelText('ویژگی‌ها (JSON، اختیاری)');
    await user.click(attributesInput);
    await user.paste('{"department":"sales"}');
    await user.click(within(dialog).getByRole('button', { name: 'دعوت' }));

    await waitFor(() =>
      expect(inviteMember).toHaveBeenCalledWith({
        email: 'new@example.com',
        displayName: 'New User',
        roleKeys: ['app-a:editor'],
        attributes: { department: 'sales' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(listMembers.mock.calls.length).toBeGreaterThan(1);
  });

  it('rejects invalid attribute JSON without calling the API', async () => {
    const user = userEvent.setup();
    const { client, inviteMember } = fakeClient();
    renderModule(client);

    await screen.findByText('سارا محمدی');
    await user.click(screen.getByRole('button', { name: 'دعوت کاربر' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('ایمیل'), 'new@example.com');
    const invalidAttributes = within(dialog).getByLabelText('ویژگی‌ها (JSON، اختیاری)');
    await user.click(invalidAttributes);
    await user.paste('{not-json');
    await user.click(within(dialog).getByRole('button', { name: 'دعوت' }));

    expect(
      await within(dialog).findByText('ویژگی‌ها باید یک شیء JSON معتبر باشند.'),
    ).toBeInTheDocument();
    expect(inviteMember).not.toHaveBeenCalled();
  });

  it('shows an invite error returned by the API', async () => {
    const user = userEvent.setup();
    const inviteMember = vi
      .fn()
      .mockRejectedValue(new MfeApiError('conflict', 409, 'Conflict', 'user is already a member'));
    const { client } = fakeClient({ inviteMember });
    renderModule(client);

    await screen.findByText('سارا محمدی');
    await user.click(screen.getByRole('button', { name: 'دعوت کاربر' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('ایمیل'), 'sara@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'دعوت' }));

    expect(await within(dialog).findByText('user is already a member')).toBeInTheDocument();
  });

  it('suspends and re-activates memberships', async () => {
    const user = userEvent.setup();
    const { client, updateMember } = fakeClient();
    renderModule(client);

    await screen.findByText('سارا محمدی');
    await user.click(screen.getByRole('button', { name: 'تعلیق' }));
    await waitFor(() => expect(updateMember).toHaveBeenCalledWith('u1', { status: 'suspended' }));

    await user.click(screen.getByRole('button', { name: 'فعال‌سازی' }));
    await waitFor(() => expect(updateMember).toHaveBeenCalledWith('u2', { status: 'active' }));
  });

  it('reports a status change failure', async () => {
    const user = userEvent.setup();
    const updateMember = vi.fn().mockRejectedValue(new MfeApiError('server', 500, 'Server'));
    const { client } = fakeClient({ updateMember });
    renderModule(client);

    await screen.findByText('سارا محمدی');
    await user.click(screen.getByRole('button', { name: 'تعلیق' }));

    expect(await screen.findByText('خطا در دریافت اعضا')).toBeInTheDocument();
  });

  it('replaces the app roles of a member', async () => {
    const user = userEvent.setup();
    const { client, replaceRoles } = fakeClient();
    renderModule(client);

    await screen.findByText('سارا محمدی');
    await user.click(screen.getAllByRole('button', { name: 'نقش‌ها' })[0]!);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'عضو' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(dialog).getByRole('button', { name: 'ویرایشگر' }));
    await user.click(within(dialog).getByRole('button', { name: 'ذخیره نقش‌ها' }));

    await waitFor(() =>
      expect(replaceRoles).toHaveBeenCalledWith('u1', ['app-a:member', 'app-a:editor']),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('reports a role save failure inside the dialog', async () => {
    const user = userEvent.setup();
    const replaceRoles = vi.fn().mockRejectedValue(new MfeApiError('forbidden', 403, 'Forbidden'));
    const { client } = fakeClient({ replaceRoles });
    renderModule(client);

    await screen.findByText('سارا محمدی');
    await user.click(screen.getAllByRole('button', { name: 'نقش‌ها' })[0]!);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'ذخیره نقش‌ها' }));

    expect(
      await within(dialog).findByText('دسترسی به مدیریت اعضای این اپ مجاز نیست.'),
    ).toBeInTheDocument();
  });

  it('explains when the client has no roles', async () => {
    const user = userEvent.setup();
    const { client } = fakeClient({ listRoles: vi.fn().mockResolvedValue([]) });
    renderModule(client);

    await screen.findByText('سارا محمدی');
    await user.click(screen.getByRole('button', { name: 'دعوت کاربر' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('نقشی برای این اپ تعریف نشده است.')).toBeInTheDocument();
  });

  it('paginates members', async () => {
    const user = userEvent.setup();
    const listMembers = vi.fn().mockResolvedValue(pageOf(members, 25));
    const { client } = fakeClient({ listMembers });
    renderModule(client);

    await screen.findByText('سارا محمدی');
    expect(screen.getByRole('button', { name: 'قبلی' })).toBeDisabled();

    const nextButton = screen.getByRole('button', { name: 'بعدی' });
    expect(nextButton).toBeEnabled();
    await user.click(nextButton);
    await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(2));
    expect(listMembers.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ page: 2 }));
    const pageInfo = await screen.findByText(
      (_content, element) => element?.tagName === 'SPAN' && element.textContent === 'صفحه 2 از 3',
    );
    expect(pageInfo).toBeInTheDocument();
  });

  it('isolates client ids, emails and role keys from the RTL paragraph direction', async () => {
    const { client } = fakeClient();
    renderModule(client);

    await screen.findByText('سارا محمدی');

    const email = screen.getByText('sara@example.com');
    expect(email.tagName).toBe('BDI');
    expect(email).toHaveAttribute('dir', 'ltr');

    const clientIds = screen.getAllByText('app-a');
    expect(clientIds.length).toBeGreaterThan(0);
    for (const element of clientIds) {
      expect(element.tagName).toBe('BDI');
      expect(element).toHaveAttribute('dir', 'ltr');
    }

    const roleKey = screen.getByText('app-a:member');
    expect(roleKey.tagName).toBe('BDI');

    // The table keeps logical alignment; no physical text-left/right utility is used.
    expect(screen.getByRole('columnheader', { name: 'ایمیل' })).toHaveClass('text-start');
    expect(screen.getByRole('cell', { name: 'sara@example.com' })).toHaveClass('text-start');
  });

  it('renders the same structure in LTR and keeps machine-readable values scoped', async () => {
    const { client } = fakeClient();
    render(
      <IdpnRoot locale="en-US" dir="ltr">
        <UserManagement clientId="app-a" apiClient={client} locale="en-US" dir="ltr" />
      </IdpnRoot>,
    );

    await screen.findByText('سارا محمدی');
    const section = document.querySelector('[data-client-id="app-a"]');
    expect(section).toHaveAttribute('dir', 'ltr');
    expect(section).toHaveAttribute('lang', 'en-US');
    expect(screen.getByText('sara@example.com')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByRole('columnheader', { name: 'Email' })).toHaveClass('text-start');
  });
});
