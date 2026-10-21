import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { ForgotPasswordPage, SetPasswordPage } from '@/app/account-flows';
import { IdpnRoot } from '@/app/idpn-root';
import { AccountRoot } from '@/mfe/account';
import {
  AccountApiError,
  type AccountApiClient,
  type AccountMfaStatus,
  type AccountProfile,
} from '@/mfe/account-api-client';
import { MfeApiError, type MfeApiClient, type MfeMember } from '@/mfe/api-client';
import { UserManagementRoot } from '@/mfe/user-management';

/**
 * Phase-4 UI regression edges (docs/testing.md 8, docs/micro-frontend.md):
 * RTL + accessible labels for the new MFA/passkey/invite/role surfaces, portal containment,
 * token-free events and mount/unmount of the account remote.
 */

const profile: AccountProfile = {
  id: 'u-1',
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

const enabledMfa: AccountMfaStatus = {
  factors: [
    {
      id: 'factor-1',
      type: 'totp',
      name: 'authenticator',
      confirmed: true,
      createdAt: '2026-10-19T09:00:00.000Z',
      lastUsedAt: null,
    },
  ],
  totp: {
    id: 'factor-1',
    type: 'totp',
    name: 'authenticator',
    confirmed: true,
    createdAt: '2026-10-19T09:00:00.000Z',
    lastUsedAt: null,
  },
  webauthn: [],
  recoveryCodesRemaining: 8,
  available: true,
};

function fakeAccountClient(overrides: Partial<AccountApiClient> = {}): AccountApiClient {
  const base: AccountApiClient = {
    getProfile: vi.fn().mockResolvedValue(profile),
    resendVerification: vi.fn().mockResolvedValue({ status: 'accepted' }),
    changePassword: vi.fn(),
    listSessions: vi.fn().mockResolvedValue({ items: [], page: 1, limit: 10, total: 0 }),
    closeSession: vi.fn(),
    switchContext: vi.fn(),
    getMfaStatus: vi.fn().mockResolvedValue(enabledMfa),
    enrollTotp: vi.fn(),
    verifyTotpEnrollment: vi.fn(),
    disableTotp: vi.fn(),
    regenerateRecoveryCodes: vi.fn(),
    beginPasskeyRegistration: vi.fn(),
    finishPasskeyRegistration: vi.fn(),
    beginPasskeyAuthentication: vi.fn(),
    finishPasskeyAuthentication: vi.fn(),
    renamePasskey: vi.fn(),
    deletePasskey: vi.fn(),
  };
  return { ...base, ...overrides };
}

const member: MfeMember = {
  membershipId: 'm-1',
  userId: 'u-2',
  email: 'reza@example.com',
  username: 'reza',
  displayName: 'رضا کریمی',
  userStatus: 'active',
  status: 'active',
  attributes: {},
  roleKeys: ['app-a:admin'],
  invitedAt: null,
  joinedAt: '2026-10-01T09:00:00.000Z',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
};

const roles = [
  {
    id: 'r-1',
    key: 'app-a:admin',
    name: 'مدیر اپ',
    description: 'مدیر',
    isDefault: false,
  },
  {
    id: 'r-2',
    key: 'app-a:viewer',
    name: 'مشاهده‌گر',
    description: 'فقط مشاهده',
    isDefault: true,
  },
];

function fakeMfeClient(overrides: Partial<MfeApiClient> = {}): MfeApiClient {
  const base: MfeApiClient = {
    listMembers: vi.fn().mockResolvedValue({ items: [member], page: 1, limit: 10, total: 1 }),
    listRoles: vi.fn().mockResolvedValue(roles),
    inviteMember: vi.fn().mockResolvedValue({ member, createdUser: true }),
    updateMember: vi.fn().mockResolvedValue(member),
    replaceRoles: vi.fn().mockResolvedValue(member),
  };
  return { ...base, ...overrides };
}

function renderInRoot(children: ReactNode, locale = 'fa-IR'): void {
  render(
    <IdpnRoot locale={locale} dir={locale === 'fa-IR' ? 'rtl' : 'ltr'}>
      {children}
    </IdpnRoot>,
  );
}

describe('account MFA and passkey forms', () => {
  it('renders every control in RTL with an accessible label', async () => {
    render(<AccountRoot apiClient={fakeAccountClient()} locale="fa-IR" />);

    const root = await screen.findByTestId('idpn-root');
    expect(root).toHaveAttribute('dir', 'rtl');
    expect(root).toHaveAttribute('lang', 'fa-IR');

    const section = await screen.findByTestId('mfa-section');
    expect(section).toBeVisible();
    expect(screen.getByRole('heading', { name: 'ورود دومرحله‌ای (MFA)' })).toBeVisible();

    // Regenerate + disable forms.
    expect(screen.getByLabelText('رمز عبور فعلی')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('رمز عبور فعلی برای غیرفعال‌سازی')).toHaveAttribute(
      'type',
      'password',
    );
    const code = screen.getByLabelText('یا کد ۶ رقمی');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('dir', 'ltr');

    // Passkey enrollment form.
    expect(screen.getByLabelText('نام دستگاه')).toBeVisible();
    expect(screen.getByRole('button', { name: 'افزودن Passkey' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Passkeyها' })).toBeVisible();
  });

  it('exposes the enrollment code field label when starting TOTP enrollment', async () => {
    const enrollTotp = vi.fn().mockResolvedValue({
      factorId: 'factor-2',
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/on4net:sara?secret=JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
    const client = fakeAccountClient({
      getMfaStatus: vi.fn().mockResolvedValue({
        factors: [],
        totp: null,
        webauthn: [],
        recoveryCodesRemaining: 0,
        available: true,
      }),
      enrollTotp,
    });
    const user = userEvent.setup();
    render(<AccountRoot apiClient={client} locale="fa-IR" />);

    await screen.findByTestId('mfa-section');
    await user.type(screen.getByLabelText('رمز عبور فعلی'), 'user-password-123');
    await user.click(screen.getByRole('button', { name: 'فعال‌سازی' }));

    expect(enrollTotp).toHaveBeenCalled();
    const input = await screen.findByLabelText('کد ۶ رقمی');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('dir', 'ltr');
    expect(screen.getByText('کلید دستی')).toBeVisible();
  });
});

describe('user-management dialogs', () => {
  it('keeps the invite dialog inside the MFE portal with labelled fields', async () => {
    const user = userEvent.setup();
    render(<UserManagementRoot clientId="app-a" apiClient={fakeMfeClient()} />);

    expect(await screen.findByTestId('idpn-root')).toHaveAttribute('dir', 'rtl');
    await screen.findByText(member.displayName);
    await user.click(screen.getByRole('button', { name: 'دعوت کاربر' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('دعوت عضو جدید');
    expect(within(dialog).getByLabelText('ایمیل')).toHaveAttribute('type', 'email');
    expect(within(dialog).getByLabelText('نام نمایشی (اختیاری)')).toBeVisible();
    expect(within(dialog).getByLabelText('ویژگی‌ها (JSON، اختیاری)')).toHaveAttribute(
      'aria-describedby',
      'mfe-invite-attributes-help',
    );
    expect(within(dialog).getByRole('group', { name: 'نقش‌های این اپ' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'دعوت' })).toBeEnabled();

    // Portals must not escape the micro-frontend root (CSS isolation).
    expect(screen.getByTestId('idpn-portal-root')).toContainElement(dialog);
    expect(dialog.closest('[data-testid="idpn-root"]')).not.toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('labels the role dialog and its app-scoped role toggles', async () => {
    const user = userEvent.setup();
    const replaceRoles = vi.fn().mockResolvedValue(member);
    render(<UserManagementRoot clientId="app-a" apiClient={fakeMfeClient({ replaceRoles })} />);

    await screen.findByText(member.displayName);
    const row = screen.getByText(member.displayName).closest('tr');
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'نقش‌ها' }));

    const dialog = await screen.findByRole('dialog', { name: 'نقش‌های رضا کریمی' });
    const group = within(dialog).getByRole('group', { name: 'نقش‌های این اپ' });
    const admin = within(group).getByRole('button', { name: 'مدیر اپ' });
    const viewer = within(group).getByRole('button', { name: 'مشاهده‌گر' });
    expect(admin).toHaveAttribute('aria-pressed', 'true');
    expect(viewer).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('idpn-portal-root')).toContainElement(dialog);

    await user.click(viewer);
    expect(viewer).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(dialog).getByRole('button', { name: 'ذخیره نقش‌ها' }));
    expect(replaceRoles).toHaveBeenCalledWith('u-2', ['app-a:admin', 'app-a:viewer']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('module events', () => {
  it('never places a token in account events or rendered output', async () => {
    const events: unknown[] = [];
    const client = fakeAccountClient({
      getProfile: vi
        .fn()
        .mockRejectedValue(new AccountApiError('unauthorized', 401, 'Unauthorized')),
    });
    renderInRoot(
      <AccountRoot apiClient={client} locale="fa-IR" onEvent={(event) => events.push(event)} />,
    );

    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ type: 'auth:error', code: 'unauthorized' });
    expect(JSON.stringify(events).toLowerCase()).not.toContain('token');
    expect(JSON.stringify(events).toLowerCase()).not.toContain('secret');
  });

  it('never places an SPA token in user-management events or the DOM', async () => {
    const token = 'spa-access-token-value';
    const events: unknown[] = [];
    const client = fakeMfeClient({
      listMembers: vi.fn().mockRejectedValue(new MfeApiError('forbidden', 403, 'Forbidden', token)),
    });
    const { container } = render(
      <UserManagementRoot
        clientId="app-a"
        apiClient={client}
        getAccessToken={() => token}
        locale="fa-IR"
        onEvent={(event) => events.push(event)}
      />,
    );

    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ type: 'auth:error', code: 'forbidden' });
    expect(JSON.stringify(events)).not.toContain(token);
    expect(container.innerHTML).not.toContain(token);
  });
});

describe('account remote mount lifecycle', () => {
  it('mounts, unmounts and re-mounts without duplicating the module or portal', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const client = fakeAccountClient();

    const first = createRoot(container);
    await act(async () => {
      first.render(<AccountRoot apiClient={client} locale="fa-IR" />);
    });
    expect(await screen.findByTestId('account-module')).toBeVisible();
    expect(container.querySelectorAll('[data-testid="account-module"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="idpn-portal-root"]')).toHaveLength(1);

    await act(async () => {
      first.unmount();
    });
    expect(container.querySelector('[data-testid="account-module"]')).toBeNull();
    expect(container.innerHTML).toBe('');

    const second = createRoot(container);
    await act(async () => {
      second.render(<AccountRoot apiClient={client} locale="fa-IR" />);
    });
    expect(await screen.findByTestId('account-module')).toBeVisible();
    expect(container.querySelectorAll('[data-testid="account-module"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="idpn-portal-root"]')).toHaveLength(1);

    await act(async () => {
      second.unmount();
    });
    container.remove();
  });
});

describe('account flow forms', () => {
  it('renders the forgot-password form in RTL with a labelled email field', async () => {
    renderInRoot(<ForgotPasswordPage locale="fa-IR" onSubmit={vi.fn()} />);

    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByLabelText('ایمیل یا نام کاربری')).toHaveAttribute('type', 'email');
    expect(screen.getByRole('heading', { name: 'بازیابی رمز عبور' })).toBeVisible();
  });

  it('links password validation errors to the labelled fields', async () => {
    const user = userEvent.setup();
    renderInRoot(
      <SetPasswordPage locale="fa-IR" mode="reset" token="single-use-token" onSubmit={vi.fn()} />,
    );

    const password = screen.getByLabelText('رمز عبور جدید');
    const confirmation = screen.getByLabelText('تکرار رمز عبور');
    await user.type(password, 'short');
    await user.type(confirmation, 'different');
    await user.click(screen.getByRole('button', { name: 'ذخیره رمز عبور' }));

    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAttribute('aria-describedby', 'set-password-new-error');
    expect(confirmation).toHaveAttribute('aria-describedby', 'set-password-confirm-error');
    expect(screen.getByText('رمز عبور باید حداقل ۱۲ کاراکتر باشد.')).toHaveAttribute(
      'role',
      'alert',
    );
    expect(screen.getByText('تکرار رمز عبور با رمز واردشده یکسان نیست.')).toHaveAttribute(
      'role',
      'alert',
    );
  });
});
