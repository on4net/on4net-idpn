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
import type { PasskeyDriver } from './passkey-client';

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
    loginContext: 'customer-admin',
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
    loginContext: null,
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
  resendVerification: ReturnType<typeof vi.fn>;
  changePassword: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
  switchContext: ReturnType<typeof vi.fn>;
  getMfaStatus: ReturnType<typeof vi.fn>;
  enrollTotp: ReturnType<typeof vi.fn>;
  verifyTotpEnrollment: ReturnType<typeof vi.fn>;
  disableTotp: ReturnType<typeof vi.fn>;
  regenerateRecoveryCodes: ReturnType<typeof vi.fn>;
  beginPasskeyRegistration: ReturnType<typeof vi.fn>;
  finishPasskeyRegistration: ReturnType<typeof vi.fn>;
  beginPasskeyAuthentication: ReturnType<typeof vi.fn>;
  finishPasskeyAuthentication: ReturnType<typeof vi.fn>;
  renamePasskey: ReturnType<typeof vi.fn>;
  deletePasskey: ReturnType<typeof vi.fn>;
}

const recoveryCodes = Array.from({ length: 10 }, (_, index) => `ABCDE-FGHJ${index}`);

const enabledMfa = {
  factors: [
    {
      id: 'factor-1',
      type: 'totp' as const,
      name: 'authenticator',
      confirmed: true,
      createdAt: '2026-10-19T09:00:00.000Z',
      lastUsedAt: null,
    },
  ],
  totp: {
    id: 'factor-1',
    type: 'totp' as const,
    name: 'authenticator',
    confirmed: true,
    createdAt: '2026-10-19T09:00:00.000Z',
    lastUsedAt: null,
  },
  recoveryCodesRemaining: 8,
  available: true,
  webauthn: [],
};

const disabledMfa = {
  factors: [],
  totp: null,
  recoveryCodesRemaining: 0,
  available: true,
  webauthn: [],
};

const passkeyFactor = {
  id: 'passkey-1',
  type: 'webauthn' as const,
  name: 'My laptop',
  confirmed: true,
  createdAt: '2026-10-19T09:30:00.000Z',
  lastUsedAt: '2026-10-19T10:00:00.000Z',
  transports: ['internal'],
  deviceType: 'multiDevice',
  backedUp: true,
};

function fakeClient(overrides: Partial<Record<keyof AccountApiClient, unknown>> = {}): FakeClient {
  const getProfile = vi.fn().mockResolvedValue(profile);
  const resendVerification = vi.fn().mockResolvedValue({ status: 'accepted' });
  const changePassword = vi.fn().mockResolvedValue({
    ok: true,
    revokedSessions: 1,
    revokedRefreshTokens: 2,
    keptCurrentSession: true,
  });
  const listSessions = vi.fn().mockResolvedValue({ items: sessions, page: 1, limit: 25, total: 2 });
  const closeSession = vi.fn().mockResolvedValue({ revoked: true, alreadyRevoked: false });
  const switchContext = vi.fn().mockResolvedValue({
    ok: true,
    loginContext: 'customer-team',
    previousLoginContext: 'customer-admin',
    session: { id: 's1', loginContext: 'customer-team' },
  });
  const getMfaStatus = vi.fn().mockResolvedValue(disabledMfa);
  const enrollTotp = vi.fn().mockResolvedValue({
    factorId: 'factor-1',
    secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    otpauthUri:
      'otpauth://totp/auth.example.com:sara%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  const verifyTotpEnrollment = vi.fn().mockResolvedValue({ ok: true, recoveryCodes });
  const disableTotp = vi.fn().mockResolvedValue({ ok: true });
  const regenerateRecoveryCodes = vi.fn().mockResolvedValue({ recoveryCodes });
  const beginPasskeyRegistration = vi.fn().mockResolvedValue({
    challengeId: 'passkey-challenge-1',
    options: { challenge: 'challenge-value' },
  });
  const finishPasskeyRegistration = vi.fn().mockResolvedValue({
    ok: true,
    factor: { id: 'passkey-1', type: 'webauthn', name: 'My laptop', confirmed: true },
  });
  const beginPasskeyAuthentication = vi.fn().mockResolvedValue({
    challengeId: 'passkey-authentication-1',
    options: { challenge: 'challenge-value' },
  });
  const finishPasskeyAuthentication = vi.fn().mockResolvedValue({
    ok: true,
    acr: 'urn:on4net:acr:mfa',
    amr: ['pwd', 'webauthn', 'hwk'],
  });
  const renamePasskey = vi.fn().mockResolvedValue({ ok: true });
  const deletePasskey = vi.fn().mockResolvedValue({ ok: true });

  const client = {
    getProfile,
    resendVerification,
    changePassword,
    listSessions,
    closeSession,
    switchContext,
    getMfaStatus,
    enrollTotp,
    verifyTotpEnrollment,
    disableTotp,
    regenerateRecoveryCodes,
    beginPasskeyRegistration,
    finishPasskeyRegistration,
    beginPasskeyAuthentication,
    finishPasskeyAuthentication,
    renamePasskey,
    deletePasskey,
    ...overrides,
  } as unknown as AccountApiClient;

  return { client, ...(client as unknown as Omit<FakeClient, 'client'>) };
}

/** Fake WebAuthn driver: proves the UI never needs a real authenticator in jsdom. */
const passkeyDriver = (supported = true) =>
  ({
    supported: vi.fn().mockReturnValue(supported),
    register: vi.fn().mockResolvedValue({
      id: 'credential-1',
      rawId: 'credential-1',
      type: 'public-key',
      response: { clientDataJSON: 'client-data' },
      clientExtensionResults: {},
    }),
    authenticate: vi.fn().mockResolvedValue({
      id: 'credential-1',
      rawId: 'credential-1',
      type: 'public-key',
      response: { clientDataJSON: 'client-data' },
      clientExtensionResults: {},
    }),
  }) as unknown as PasskeyDriver;

const renderAccount = (fake: FakeClient, locale = 'fa-IR', driver?: PasskeyDriver) =>
  render(
    <Account
      apiClient={fake.client}
      locale={locale}
      onEvent={undefined}
      {...(driver === undefined ? {} : { passkeys: driver })}
    />,
  );

describe('Account MFE', () => {
  it('renders the Persian profile, sessions and the MFA section', async () => {
    const fake = fakeClient();
    const { container } = renderAccount(fake);

    await screen.findByText('سارا محمدی');
    expect(screen.getByRole('heading', { name: 'حساب کاربری' })).toBeVisible();
    expect(screen.getByText('sara@example.com')).toBeVisible();
    expect(screen.getByText('فعال')).toBeVisible();
    expect(screen.getByText('نشست فعلی')).toBeVisible();
    expect(screen.getByRole('button', { name: 'بستن نشست s2' })).toBeInTheDocument();
    expect(screen.getByTestId('mfa-section')).toBeVisible();
    expect(screen.getByTestId('mfa-badge')).toHaveTextContent('غیرفعال');
    expect(screen.getByRole('button', { name: 'فعال‌سازی' })).toBeEnabled();
    expect(container.querySelector('[data-testid="account-module"]')).toHaveAttribute('dir', 'rtl');
  });

  it('offers the server-approved context switch and reports the new context', async () => {
    const fake = fakeClient({
      listSessions: vi.fn().mockResolvedValue({
        items: [
          {
            ...sessions[0],
            switchableContexts: [
              { key: 'customer-team', name: 'تیم مشتری', allowed: true },
              {
                key: 'ledger-admin',
                name: 'دفتر کل',
                allowed: false,
                reason: 'interaction_required',
              },
            ],
          },
          sessions[1],
        ],
        page: 1,
        limit: 25,
        total: 2,
      }),
    });
    renderAccount(fake);

    await screen.findByText('نشست فعلی');
    const allowed = screen.getByTestId('session-switch-customer-team');
    expect(allowed).toBeEnabled();
    // A step-up context is advertised but cannot be entered from this session.
    expect(screen.getByTestId('session-switch-ledger-admin')).toBeDisabled();

    await userEvent.setup().click(allowed);

    expect(fake.switchContext).toHaveBeenCalledWith('customer-team');
    expect(await screen.findByText('نشست به customer-team تغییر کرد.')).toBeVisible();
  });

  it('explains that a refused switch needs a fresh two-step sign-in', async () => {
    const fake = fakeClient({
      listSessions: vi.fn().mockResolvedValue({
        items: [
          {
            ...sessions[0],
            switchableContexts: [{ key: 'customer-team', name: 'تیم مشتری', allowed: true }],
          },
        ],
        page: 1,
        limit: 25,
        total: 1,
      }),
      switchContext: vi
        .fn()
        .mockRejectedValue(
          new AccountApiError('forbidden', 403, 'Forbidden', { code: 'interaction_required' }),
        ),
    });
    renderAccount(fake);

    await userEvent.setup().click(await screen.findByTestId('session-switch-customer-team'));

    expect(await screen.findByTestId('sessions-error')).toHaveTextContent('ورود دومرحله‌ای تازه');
  });

  it('shows an unverified email and resends the verification link', async () => {
    const fake = fakeClient({
      getProfile: vi.fn().mockResolvedValue({ ...profile, emailVerified: false }),
    });
    renderAccount(fake);

    const button = await screen.findByRole('button', {
      name: 'ارسال دوباره لینک تأیید',
    });
    expect(screen.getByText('تأییدنشده')).toBeVisible();

    await userEvent.setup().click(button);

    expect(fake.resendVerification).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('لینک تأیید ارسال شد.')).toBeVisible();
  });

  it('refreshes the profile when the account was already verified', async () => {
    const getProfile = vi
      .fn()
      .mockResolvedValueOnce({ ...profile, emailVerified: false })
      .mockResolvedValueOnce(profile);
    const fake = fakeClient({
      getProfile,
      resendVerification: vi.fn().mockResolvedValue({ status: 'already_verified' }),
    });
    renderAccount(fake);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'ارسال دوباره لینک تأیید' }));

    expect(await screen.findByText('ایمیل شما از قبل تأیید شده است.')).toBeVisible();
    await waitFor(() => expect(getProfile).toHaveBeenCalledTimes(2));
  });

  it('shows an accessible error when the verification mail cannot be sent', async () => {
    const fake = fakeClient({
      getProfile: vi.fn().mockResolvedValue({ ...profile, emailVerified: false }),
      resendVerification: vi
        .fn()
        .mockRejectedValue(new AccountApiError('server', 503, 'unavailable')),
    });
    renderAccount(fake);

    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'ارسال دوباره لینک تأیید' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ارسال لینک تأیید انجام نشد.');
  });

  it('renders English in LTR through the self-contained root', async () => {
    const fake = fakeClient();
    render(<AccountRoot apiClient={fake.client} locale="en-US" />);

    await screen.findByText('sara@example.com');
    expect(screen.getByRole('heading', { name: 'Account' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Change password' })).toBeVisible();
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'ltr');
  });

  it('isolates machine-readable profile and session values from RTL text', async () => {
    const fake = fakeClient();
    const { container } = renderAccount(fake);

    await screen.findByText('sara@example.com');

    const email = screen.getByText('sara@example.com');
    expect(email.tagName).toBe('BDI');
    expect(email).toHaveAttribute('dir', 'ltr');

    const username = screen.getByText('sara');
    expect(username.tagName).toBe('BDI');

    const clientIds = screen.getAllByText('app-a');
    expect(clientIds.length).toBeGreaterThan(0);
    for (const element of clientIds) {
      expect(element.tagName).toBe('BDI');
    }

    const address = screen.getByText('10.0.0.1');
    expect(address.tagName).toBe('BDI');
    expect(screen.getByText('Firefox').tagName).toBe('BDI');

    const section = container.querySelector('[data-testid="account-module"]');
    expect(section).toHaveAttribute('dir', 'rtl');
    expect(section).toHaveAttribute('lang', 'fa-IR');
    expect(screen.getByRole('columnheader', { name: 'اپ' })).toHaveClass('text-start');
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

describe('Account MFA section', () => {
  it('enrolls TOTP, shows the recovery codes once and refreshes the status', async () => {
    const fake = fakeClient();
    fake.getMfaStatus.mockResolvedValueOnce(disabledMfa).mockResolvedValue(enabledMfa);
    renderAccount(fake);
    await screen.findByText('سارا محمدی');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('رمز عبور فعلی'), 'user-password-123');
    await user.click(screen.getByTestId('mfa-enable'));

    expect(fake.enrollTotp).toHaveBeenCalledTimes(1);
    const secret = await screen.findByTestId('mfa-secret');
    expect(secret).toHaveTextContent('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(secret).toHaveAttribute('dir', 'ltr');

    const codeInput = screen.getByLabelText('کد ۶ رقمی');
    expect(codeInput).toHaveAttribute('autocomplete', 'one-time-code');
    await user.type(codeInput, '123456');
    await user.click(screen.getByTestId('mfa-verify'));

    expect(fake.verifyTotpEnrollment).toHaveBeenCalledWith({
      factorId: 'factor-1',
      code: '123456',
    });
    const codes = await screen.findByTestId('mfa-recovery-codes');
    expect(codes).toHaveTextContent(recoveryCodes[0] ?? '');
    expect(codes).toHaveTextContent('هر کد فقط یک بار قابل استفاده است.');

    await user.click(screen.getByTestId('mfa-recovery-done'));
    expect(screen.queryByTestId('mfa-recovery-codes')).toBeNull();
    // The status is reloaded after confirmation: the badge now shows the enabled state.
    expect(await screen.findByTestId('mfa-badge')).toHaveTextContent('فعال');
  });

  it('validates the confirmation code before calling the API', async () => {
    const fake = fakeClient();
    renderAccount(fake);
    await screen.findByText('سارا محمدی');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('رمز عبور فعلی'), 'user-password-123');
    await user.click(screen.getByTestId('mfa-enable'));
    await user.type(await screen.findByLabelText('کد ۶ رقمی'), '12');
    await user.click(screen.getByTestId('mfa-verify'));

    expect(fake.verifyTotpEnrollment).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('کد تأیید را وارد کنید.');
  });

  it('maps an invalid code from the server to a safe localized error', async () => {
    const events: { type: string; code: string }[] = [];
    const fake = fakeClient({
      verifyTotpEnrollment: vi
        .fn()
        .mockRejectedValue(
          new AccountApiError('invalid', 400, 'Invalid code', { code: 'invalid_mfa_code' }),
        ),
    });
    render(
      <Account apiClient={fake.client} locale="fa-IR" onEvent={(event) => events.push(event)} />,
    );
    await screen.findByText('سارا محمدی');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('رمز عبور فعلی'), 'user-password-123');
    await user.click(screen.getByTestId('mfa-enable'));
    await user.type(await screen.findByLabelText('کد ۶ رقمی'), '123456');
    await user.click(screen.getByTestId('mfa-verify'));

    expect(await screen.findByTestId('mfa-error')).toHaveTextContent('کد واردشده معتبر نیست.');
    expect(events).toEqual([{ type: 'auth:error', code: 'invalid_mfa_code' }]);
    expect(JSON.stringify(events)).not.toContain('123456');
  });

  it('disables MFA with the current password', async () => {
    const fake = fakeClient({
      getMfaStatus: vi.fn().mockResolvedValue(enabledMfa),
    });
    renderAccount(fake);
    await screen.findByText('سارا محمدی');

    expect(screen.getByTestId('mfa-badge')).toHaveTextContent('فعال');
    expect(screen.getByText(/8 کد بازیابی باقی مانده است/)).toBeVisible();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('رمز عبور فعلی برای غیرفعال‌سازی'), 'current-password');
    await user.click(screen.getByTestId('mfa-disable'));

    expect(fake.disableTotp).toHaveBeenCalledWith({ password: 'current-password' });
    expect(await screen.findByTestId('mfa-notice')).toHaveTextContent(
      'ورود دومرحله‌ای غیرفعال شد.',
    );
  });

  it('regenerates recovery codes after a password check and shows them once', async () => {
    const fake = fakeClient({
      getMfaStatus: vi.fn().mockResolvedValue(enabledMfa),
    });
    renderAccount(fake);
    await screen.findByText('سارا محمدی');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('رمز عبور فعلی'), 'current-password');
    await user.click(screen.getByTestId('mfa-regenerate'));

    expect(fake.regenerateRecoveryCodes).toHaveBeenCalledWith({ password: 'current-password' });
    expect(await screen.findByTestId('mfa-recovery-codes')).toHaveTextContent(
      recoveryCodes[3] ?? '',
    );
  });

  it('renders the MFA section in English LTR', async () => {
    const fake = fakeClient();
    render(<AccountRoot apiClient={fake.client} locale="en-US" />);

    await screen.findByText('sara@example.com');
    expect(screen.getByRole('heading', { name: 'Two-factor authentication (MFA)' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeVisible();
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'ltr');
  });

  it('shows a load error and retries', async () => {
    const fake = fakeClient();
    fake.getMfaStatus
      .mockRejectedValueOnce(new AccountApiError('network', 0, 'network error'))
      .mockResolvedValueOnce(disabledMfa);
    renderAccount(fake);

    expect(await screen.findByTestId('mfa-load-error')).toHaveTextContent(
      'ارتباط با سرور برقرار نشد.',
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    expect(await screen.findByTestId('mfa-enable')).toBeEnabled();
    expect(fake.getMfaStatus).toHaveBeenCalledTimes(2);
  });

  it('disables enrollment when the deployment has no encryption key', async () => {
    const fake = fakeClient({
      getMfaStatus: vi.fn().mockResolvedValue({ ...disabledMfa, available: false }),
    });
    renderAccount(fake);

    const button = await screen.findByTestId('mfa-enable');
    expect(button).toBeDisabled();
    expect(screen.getByText('ورود دومرحله‌ای در حال حاضر در دسترس نیست.')).toBeVisible();
  });

  it('cancels a pending enrollment and maps unexpected errors', async () => {
    const fake = fakeClient({
      enrollTotp: vi.fn().mockRejectedValue(new Error('boom')),
    });
    renderAccount(fake);
    await screen.findByText('سارا محمدی');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('رمز عبور فعلی'), 'user-password-123');
    await user.click(screen.getByTestId('mfa-enable'));
    expect(await screen.findByTestId('mfa-error')).toHaveTextContent('عملیات MFA انجام نشد');

    fake.enrollTotp.mockResolvedValue({
      factorId: 'factor-1',
      secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      otpauthUri: 'otpauth://totp/auth.example.com:sara',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
    await user.type(screen.getByLabelText('رمز عبور فعلی'), 'user-password-123');
    await user.click(screen.getByTestId('mfa-enable'));
    await screen.findByTestId('mfa-enrollment');

    await user.click(screen.getByRole('button', { name: 'انصراف' }));
    expect(screen.queryByTestId('mfa-enrollment')).toBeNull();
    expect(await screen.findByTestId('mfa-badge')).toHaveTextContent('غیرفعال');
  });

  it('validates the disable and regenerate forms locally', async () => {
    const fake = fakeClient({ getMfaStatus: vi.fn().mockResolvedValue(enabledMfa) });
    renderAccount(fake);
    await screen.findByText('سارا محمدی');
    const user = userEvent.setup();

    await user.click(screen.getByTestId('mfa-disable'));
    expect(fake.disableTotp).not.toHaveBeenCalled();
    expect(screen.getByTestId('mfa-error')).toHaveTextContent(
      'برای غیرفعال‌سازی، رمز عبور فعلی یا یک کد معتبر وارد کنید.',
    );

    await user.click(screen.getByTestId('mfa-regenerate'));
    expect(fake.regenerateRecoveryCodes).not.toHaveBeenCalled();
    expect(screen.getByTestId('mfa-error')).toHaveTextContent('رمز فعلی را وارد کنید.');
  });

  it('shows the recovery-rotation notice and formats the last use time', async () => {
    const usedMfa = {
      ...enabledMfa,
      totp: { ...enabledMfa.totp, lastUsedAt: '2026-10-19T10:00:00.000Z' },
    };
    const fake = fakeClient({ getMfaStatus: vi.fn().mockResolvedValue(usedMfa) });
    renderAccount(fake);
    await screen.findByText('سارا محمدی');
    const user = userEvent.setup();

    expect(screen.queryByText(/هرگز/)).toBeNull();

    await user.type(screen.getByLabelText('رمز عبور فعلی'), 'current-password');
    await user.click(screen.getByTestId('mfa-regenerate'));

    expect(await screen.findByTestId('mfa-notice')).toHaveTextContent(
      'کدهای بازیابی جدید ساخته شد.',
    );
  });

  it('shows the passkey empty state and enrols a passkey through the browser driver', async () => {
    const enrolledStatus = {
      ...disabledMfa,
      factors: [passkeyFactor],
      webauthn: [passkeyFactor],
    };
    const fake = fakeClient({
      getMfaStatus: vi.fn().mockResolvedValueOnce(disabledMfa).mockResolvedValue(enrolledStatus),
    });
    const driver = passkeyDriver();
    renderAccount(fake, 'fa-IR', driver);
    await screen.findByText('سارا محمدی');

    expect(screen.getByTestId('passkey-empty')).toHaveTextContent('هنوز Passkey ثبت نشده است.');
    await userEvent.setup().type(screen.getByLabelText('نام دستگاه'), 'My laptop');
    await userEvent.setup().click(screen.getByTestId('passkey-enroll'));

    await waitFor(() => expect(fake.beginPasskeyRegistration).toHaveBeenCalledTimes(1));
    expect(driver.register).toHaveBeenCalledWith({ challenge: 'challenge-value' });
    expect(fake.finishPasskeyRegistration).toHaveBeenCalledWith({
      challengeId: 'passkey-challenge-1',
      response: expect.objectContaining({ id: 'credential-1' }),
      name: 'My laptop',
    });
    expect(await screen.findByTestId('passkey-list')).toHaveTextContent('My laptop');
    expect(screen.getByTestId('mfa-badge')).toHaveTextContent('فعال');
  });

  it('lists, renames and deletes a passkey with accessible labels', async () => {
    const status = { ...disabledMfa, factors: [passkeyFactor], webauthn: [passkeyFactor] };
    const fake = fakeClient({ getMfaStatus: vi.fn().mockResolvedValue(status) });
    renderAccount(fake, 'fa-IR', passkeyDriver());
    await screen.findByText('سارا محمدی');
    const user = userEvent.setup();

    expect(screen.getByTestId('passkey-list')).toHaveTextContent('Passkey همگام‌شده');
    await user.click(screen.getByRole('button', { name: 'تغییر نام My laptop' }));
    const rename = screen.getByLabelText('نام دستگاه', {
      selector: 'input#passkey-rename-passkey-1',
    });
    await user.clear(rename);
    await user.type(rename, 'Office key');
    await user.click(screen.getByRole('button', { name: 'ذخیره' }));

    expect(fake.renamePasskey).toHaveBeenCalledWith({
      factorId: 'passkey-1',
      name: 'Office key',
    });
    expect(await screen.findByTestId('mfa-notice')).toHaveTextContent('نام Passkey تغییر کرد.');

    await user.click(screen.getByRole('button', { name: 'حذف Passkey My laptop' }));
    expect(fake.deletePasskey).toHaveBeenCalledWith('passkey-1');
    expect(await screen.findByText('Passkey حذف شد.')).toBeVisible();
  });

  it('explains an already-registered passkey and an unsupported browser', async () => {
    const duplicate = fakeClient({
      finishPasskeyRegistration: vi.fn().mockRejectedValue(
        new AccountApiError('conflict', 409, 'duplicate', {
          code: 'webauthn_credential_exists',
        }),
      ),
    });
    const { unmount } = renderAccount(duplicate, 'fa-IR', passkeyDriver());
    await screen.findByText('سارا محمدی');
    await userEvent.setup().click(screen.getByTestId('passkey-enroll'));
    expect(await screen.findByTestId('mfa-error')).toHaveTextContent(
      'این Passkey قبلاً برای حسابی ثبت شده است.',
    );
    unmount();

    const unsupported = fakeClient();
    renderAccount(unsupported, 'fa-IR', passkeyDriver(false));
    await screen.findByText('سارا محمدی');
    await userEvent.setup().click(screen.getByTestId('passkey-enroll'));
    expect(await screen.findByTestId('mfa-error')).toHaveTextContent(
      'این مرورگر از Passkey پشتیبانی نمی‌کند.',
    );
    expect(unsupported.beginPasskeyRegistration).not.toHaveBeenCalled();
  });

  it('renders the passkey section in English LTR', async () => {
    const fake = fakeClient();
    render(<AccountRoot apiClient={fake.client} locale="en-US" />);

    await screen.findByText('sara@example.com');
    expect(screen.getByRole('heading', { name: 'Passkeys' })).toBeVisible();
    expect(screen.getByTestId('passkey-empty')).toHaveTextContent('No passkey has been added yet.');
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'ltr');
  });
});
