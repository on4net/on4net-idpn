import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  AccountApiError,
  type AccountApiClient,
  type AccountProfile,
  type AccountSession,
} from './account-api-client';
import { Account, AccountRoot } from './account';

const profile: AccountProfile = {
  id: 'u1',
  username: 'sara',
  email: 'sara@example.com',
  displayName: 'سارا محمدی',
  phone: null,
  avatarUrl: null,
  locale: 'fa-IR',
  status: 'active',
  emailVerified: true,
  mustChangePassword: false,
  createdAt: '2026-10-19T09:00:00.000Z',
  passwordChangedAt: null,
};

const sessions: AccountSession[] = [
  {
    id: 's1',
    userId: 'u1',
    clientId: 'app-a',
    status: 'active',
    createdAt: '2026-10-19T09:00:00.000Z',
    lastSeenAt: '2026-10-19T10:00:00.000Z',
    idleExpiresAt: '2026-10-19T10:30:00.000Z',
    absoluteExpiresAt: '2026-10-19T21:00:00.000Z',
    ip: '10.0.0.1',
    userAgent: 'Firefox',
    amr: ['pwd'],
    acr: 'urn:on4net:acr:pwd',
    revokedAt: null,
    revokeReason: null,
    current: true,
  },
  {
    id: 's2',
    userId: 'u1',
    clientId: 'app-b',
    status: 'active',
    createdAt: '2026-10-18T09:00:00.000Z',
    lastSeenAt: '2026-10-18T10:00:00.000Z',
    idleExpiresAt: '2026-10-18T10:30:00.000Z',
    absoluteExpiresAt: '2026-10-18T21:00:00.000Z',
    ip: null,
    userAgent: null,
    amr: ['pwd'],
    acr: 'urn:on4net:acr:pwd',
    revokedAt: null,
    revokeReason: null,
    current: false,
  },
];

interface FakeClient {
  client: AccountApiClient;
  getProfile: ReturnType<typeof vi.fn>;
  changePassword: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
}

function fakeClient(overrides: Partial<Record<keyof AccountApiClient, unknown>> = {}): FakeClient {
  const getProfile = vi.fn().mockResolvedValue(profile);
  const changePassword = vi.fn().mockResolvedValue({
    ok: true,
    revokedSessions: 1,
    revokedRefreshTokens: 2,
    keptCurrentSession: true,
  });
  const listSessions = vi.fn().mockResolvedValue({ items: sessions, page: 1, limit: 25, total: 2 });
  const closeSession = vi.fn().mockResolvedValue({ revoked: true, alreadyRevoked: false });

  const client = {
    getProfile,
    changePassword,
    listSessions,
    closeSession,
    ...overrides,
  } as unknown as AccountApiClient;

  return { client, getProfile, changePassword, listSessions, closeSession };
}

const renderAccount = (fake: FakeClient, locale = 'fa-IR') =>
  render(<Account apiClient={fake.client} locale={locale} onEvent={undefined} />);

describe('Account MFE', () => {
  it('renders the Persian profile, sessions and the disabled MFA placeholder', async () => {
    const fake = fakeClient();
    const { container } = renderAccount(fake);

    await screen.findByText('سارا محمدی');
    expect(screen.getByRole('heading', { name: 'حساب کاربری' })).toBeVisible();
    expect(screen.getByText('sara@example.com')).toBeVisible();
    expect(screen.getByText('فعال')).toBeVisible();
    expect(screen.getByText('نشست فعلی')).toBeVisible();
    expect(screen.getByRole('button', { name: 'بستن نشست s2' })).toBeInTheDocument();
    const mfa = screen.getByRole('button', { name: 'فعال‌سازی MFA (فاز ۴)' });
    expect(mfa).toBeDisabled();
    expect(container.querySelector('[data-testid="account-module"]')).toHaveAttribute('dir', 'rtl');
  });

  it('renders English in LTR through the self-contained root', async () => {
    const fake = fakeClient();
    render(<AccountRoot apiClient={fake.client} locale="en-US" />);

    await screen.findByText('sara@example.com');
    expect(screen.getByRole('heading', { name: 'Account' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Change password' })).toBeVisible();
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'ltr');
  });

  it('shows a loading state, then an accessible error that can retry', async () => {
    const fake = fakeClient();
    fake.getProfile
      .mockRejectedValueOnce(new AccountApiError('network', 0, 'network error'))
      .mockResolvedValueOnce(profile);

    renderAccount(fake);

    const alert = await screen.findByTestId('account-error');
    expect(alert).toHaveTextContent('ارتباط با سرور برقرار نشد.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    await screen.findByText('سارا محمدی');
    expect(fake.getProfile).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('account-error')).toBeNull();
  });

  it('validates required and short passwords and links the errors with aria attributes', async () => {
    const fake = fakeClient();
    renderAccount(fake);
    await screen.findByText('سارا محمدی');
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'تغییر رمز' }));

    const current = screen.getByLabelText('رمز فعلی');
    expect(current).toHaveAttribute('aria-invalid', 'true');
    expect(current).toHaveAttribute('aria-describedby', 'account-current-password-error');
    expect(screen.getByText('رمز فعلی را وارد کنید.')).toBeVisible();
    expect(screen.getByText('رمز جدید را وارد کنید.')).toBeVisible();
    expect(fake.changePassword).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('رمز جدید'), 'short');
    await user.click(screen.getByRole('button', { name: 'تغییر رمز' }));

    expect(await screen.findByText('رمز جدید باید حداقل ۱۲ کاراکتر باشد.')).toBeVisible();
    expect(screen.getByLabelText('رمز جدید')).toHaveAttribute(
      'aria-describedby',
      'account-password-policy account-new-password-error',
    );
  });

  it('shows the server error for a wrong current password', async () => {
    const fake = fakeClient({
      changePassword: vi.fn().mockRejectedValue(
        new AccountApiError('invalid', 400, 'Invalid current password', {
          code: 'invalid_current_password',
        }),
      ),
    });
    renderAccount(fake);
    await screen.findByText('سارا محمدی');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('رمز فعلی'), 'wrong-password');
    await user.type(screen.getByLabelText('رمز جدید'), 'brand-new-password-456');
    await user.click(screen.getByRole('button', { name: 'تغییر رمز' }));

    expect(await screen.findByText('رمز فعلی نادرست است.')).toBeVisible();
    expect(screen.getByLabelText('رمز فعلی')).toHaveAttribute('aria-invalid', 'true');
  });

  it('renders every password policy violation returned by the server', async () => {
    const fake = fakeClient({
      changePassword: vi.fn().mockRejectedValue(
        new AccountApiError('invalid', 422, 'Password policy violated', {
          code: 'password_policy',
          violations: ['too_short', 'contains_identity'],
        }),
      ),
    });
    renderAccount(fake);
    await screen.findByText('سارا محمدی');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('رمز فعلی'), 'old-password-123');
    await user.type(screen.getByLabelText('رمز جدید'), 'brand-new-password-456');
    await user.click(screen.getByRole('button', { name: 'تغییر رمز' }));

    const alert = await screen.findByTestId('password-error');
    expect(alert).toHaveTextContent('رمز جدید باید حداقل ۱۲ کاراکتر باشد.');
    expect(alert).toHaveTextContent('رمز جدید نباید شامل ایمیل یا نام کاربری شما باشد.');
  });

  it('reports password reuse and generic failures without leaking details', async () => {
    const fake = fakeClient({
      changePassword: vi
        .fn()
        .mockRejectedValueOnce(
          new AccountApiError('invalid', 422, 'Password reuse', { code: 'password_reuse' }),
        )
        .mockRejectedValueOnce(new Error('boom')),
    });
    renderAccount(fake);
    await screen.findByText('سارا محمدی');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('رمز فعلی'), 'old-password-123');
    await user.type(screen.getByLabelText('رمز جدید'), 'brand-new-password-456');
    await user.click(screen.getByRole('button', { name: 'تغییر رمز' }));
    expect(await screen.findByText('رمز جدید باید با رمز فعلی متفاوت باشد.')).toBeVisible();

    await user.type(screen.getByLabelText('رمز فعلی'), 'old-password-123');
    await user.type(screen.getByLabelText('رمز جدید'), 'brand-new-password-456');
    await user.click(screen.getByRole('button', { name: 'تغییر رمز' }));
    expect(await screen.findByText('تغییر رمز انجام نشد. دوباره تلاش کنید.')).toBeVisible();
  });

  it('changes the password, clears the form and reloads the sessions', async () => {
    const fake = fakeClient();
    renderAccount(fake);
    await screen.findByText('سارا محمدی');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('رمز فعلی'), 'old-password-123');
    await user.type(screen.getByLabelText('رمز جدید'), 'brand-new-password-456');
    await user.click(screen.getByRole('button', { name: 'تغییر رمز' }));

    await waitFor(() =>
      expect(fake.changePassword).toHaveBeenCalledWith({
        currentPassword: 'old-password-123',
        newPassword: 'brand-new-password-456',
      }),
    );
    expect(await screen.findByTestId('password-success')).toHaveTextContent(
      'رمز عبور تغییر کرد. 1 نشست دیگر بسته شد.',
    );
    expect(screen.getByLabelText('رمز فعلی')).toHaveValue('');
    expect(screen.getByLabelText('رمز جدید')).toHaveValue('');
    await waitFor(() => expect(fake.listSessions).toHaveBeenCalledTimes(2));
  });

  it('closes another session and removes it from the list', async () => {
    const fake = fakeClient();
    renderAccount(fake);
    await screen.findByText('نشست فعلی');

    await userEvent.setup().click(screen.getByRole('button', { name: 'بستن نشست s2' }));

    await waitFor(() => expect(fake.closeSession).toHaveBeenCalledWith('s2'));
    expect(await screen.findByText('نشست بسته شد.')).toBeVisible();
    expect(screen.queryByTestId('session-s2')).toBeNull();
  });

  it('explains that the current session is closed by signing out', async () => {
    const fake = fakeClient({
      closeSession: vi.fn().mockRejectedValue(
        new AccountApiError('conflict', 409, 'Current session', {
          code: 'current_session',
        }),
      ),
    });
    renderAccount(fake);
    await screen.findByText('نشست فعلی');

    await userEvent.setup().click(screen.getByRole('button', { name: 'بستن نشست s2' }));

    expect(
      await screen.findByText(
        'نشست فعلی از این فهرست بسته نمی‌شود؛ برای خروج از حساب استفاده کنید.',
      ),
    ).toBeVisible();
  });

  it('shows the empty state when there is no active session', async () => {
    const fake = fakeClient({
      listSessions: vi.fn().mockResolvedValue({ items: [], page: 1, limit: 25, total: 0 }),
    });
    renderAccount(fake);

    expect(await screen.findByText('نشست فعال دیگری وجود ندارد.')).toBeVisible();
  });

  it('maps unauthorized errors and emits only a non-sensitive code', async () => {
    const events: { type: string; code: string }[] = [];
    const fake = fakeClient({
      getProfile: vi
        .fn()
        .mockRejectedValue(new AccountApiError('unauthorized', 401, 'Unauthorized')),
    });
    render(
      <Account apiClient={fake.client} locale="fa-IR" onEvent={(event) => events.push(event)} />,
    );

    expect(await screen.findByText('برای مشاهده حساب باید وارد شوید.')).toBeVisible();
    expect(events).toEqual([{ type: 'auth:error', code: 'unauthorized' }]);
    expect(JSON.stringify(events).toLowerCase()).not.toContain('token');
  });
});
