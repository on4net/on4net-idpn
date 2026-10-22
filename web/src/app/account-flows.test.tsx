import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { IdpnRoot } from './idpn-root';
import {
  ForgotPasswordPage,
  SetPasswordPage,
  VerifyEmailPage,
  type AccountFlowResult,
} from './account-flows';
import { MESSAGES, translate } from '@/i18n';

const renderInRoot = (node: React.ReactNode, locale: 'fa-IR' | 'en-US' = 'fa-IR') =>
  render(
    <IdpnRoot locale={locale} dir={locale === 'fa-IR' ? 'rtl' : 'ltr'}>
      {node}
    </IdpnRoot>,
  );

describe('account flow i18n', () => {
  it('ships every flow key in Persian and English', () => {
    const keys = Object.keys(MESSAGES['fa-IR']).filter((key) => key.startsWith('account.flow.'));

    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(MESSAGES['en-US'][key], key).toBeTruthy();
    }
    expect(translate('fa-IR', 'account.flow.forgotSent')).toContain('اگر این ایمیل');
    expect(translate('en-US', 'account.flow.forgotSent')).toBe(
      'If that email exists, a reset link has been sent.',
    );
  });
});

describe('ForgotPasswordPage', () => {
  it('validates the address before calling the API', async () => {
    const onSubmit = vi.fn();
    renderInRoot(<ForgotPasswordPage locale="fa-IR" onSubmit={onSubmit} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'ارسال لینک' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('یک ایمیل معتبر وارد کنید.')).toBeVisible();
  });

  it('shows one neutral confirmation that does not reveal account existence', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    renderInRoot(<ForgotPasswordPage locale="fa-IR" onSubmit={onSubmit} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara@example.com');
    await user.click(screen.getByRole('button', { name: 'ارسال لینک' }));

    const confirmation = await screen.findByTestId('forgot-sent');
    expect(confirmation).toHaveTextContent('اگر این ایمیل در سیستم موجود باشد');
    expect(confirmation.textContent).not.toMatch(/وجود ندارد|not found|no account/i);
    expect(onSubmit).toHaveBeenCalledWith('sara@example.com');
  });

  it('shows the rate-limit message and keeps the form', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: false, error: 'rate_limited' });
    renderInRoot(<ForgotPasswordPage locale="fa-IR" onSubmit={onSubmit} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara@example.com');
    await user.click(screen.getByRole('button', { name: 'ارسال لینک' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('تلاش‌های شما بیش از حد بود');
    expect(screen.queryByTestId('forgot-sent')).not.toBeInTheDocument();
  });

  it.each([
    ['network', 'ارتباط با سرور برقرار نشد'],
    ['server', 'خطای غیرمنتظره رخ داد'],
  ] as const)('shows the %s failure without leaking account state', async (error, message) => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: false, error });
    renderInRoot(<ForgotPasswordPage locale="fa-IR" onSubmit={onSubmit} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara@example.com');
    await user.click(screen.getByRole('button', { name: 'ارسال لینک' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });
});

describe('SetPasswordPage', () => {
  const token = 'single-use-token-value';
  const submit = vi.fn();

  it('validates length and confirmation locally', async () => {
    submit.mockReset();
    renderInRoot(<SetPasswordPage locale="fa-IR" mode="invite" token={token} onSubmit={submit} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('رمز عبور جدید'), 'short');
    await user.type(screen.getByLabelText('تکرار رمز عبور'), 'different');
    await user.click(screen.getByRole('button', { name: 'ذخیره رمز عبور' }));

    expect(screen.getByText('رمز عبور باید حداقل ۱۲ کاراکتر باشد.')).toBeVisible();
    expect(screen.getByText('تکرار رمز عبور با رمز واردشده یکسان نیست.')).toBeVisible();
    expect(submit).not.toHaveBeenCalled();
  });

  it('submits the token from memory and shows the success state', async () => {
    submit.mockReset();
    submit.mockResolvedValue({ ok: true });
    const { container } = renderInRoot(
      <SetPasswordPage locale="fa-IR" mode="reset" token={token} onSubmit={submit} />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('رمز عبور جدید'), 'a-brand-new-passphrase');
    await user.type(screen.getByLabelText('تکرار رمز عبور'), 'a-brand-new-passphrase');
    await user.click(screen.getByRole('button', { name: 'ذخیره رمز عبور' }));

    expect(await screen.findByTestId('password-done')).toBeVisible();
    expect(submit).toHaveBeenCalledWith({
      token,
      password: 'a-brand-new-passphrase',
      mode: 'reset',
    });
    expect(container.innerHTML).not.toContain(token);
  });

  it('shows a safe invalid-link state without calling the API', () => {
    submit.mockReset();
    renderInRoot(
      <SetPasswordPage locale="fa-IR" mode="invite" token={undefined} onSubmit={submit} />,
    );

    expect(screen.getByTestId('password-invalid-token')).toHaveTextContent(
      'این لینک معتبر نیست یا منقضی شده است',
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects a password longer than 128 characters locally', async () => {
    submit.mockReset();
    renderInRoot(<SetPasswordPage locale="fa-IR" mode="reset" token={token} onSubmit={submit} />);

    const user = userEvent.setup();
    const tooLong = 'a'.repeat(129);
    await user.type(screen.getByLabelText('رمز عبور جدید'), tooLong);
    await user.type(screen.getByLabelText('تکرار رمز عبور'), tooLong);
    await user.click(screen.getByRole('button', { name: 'ذخیره رمز عبور' }));

    expect(screen.getByText('رمز عبور نباید بیشتر از ۱۲۸ کاراکتر باشد.')).toBeVisible();
    expect(submit).not.toHaveBeenCalled();
  });

  it('lists server-side policy violations and keeps the link usable', async () => {
    submit.mockReset();
    submit.mockResolvedValue({
      ok: false,
      error: 'password_policy',
      violations: ['common_password', 'contains_identity'],
    });
    renderInRoot(<SetPasswordPage locale="fa-IR" mode="invite" token={token} onSubmit={submit} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('رمز عبور جدید'), 'a-brand-new-passphrase');
    await user.type(screen.getByLabelText('تکرار رمز عبور'), 'a-brand-new-passphrase');
    await user.click(screen.getByRole('button', { name: 'ذخیره رمز عبور' }));

    const alert = await screen.findByTestId('password-flow-error');
    expect(alert).toHaveTextContent('این رمز رایج است؛ رمز دیگری انتخاب کنید.');
    expect(alert).toHaveTextContent('رمز جدید نباید شامل ایمیل یا نام کاربری شما باشد.');
  });

  it('uses the default policy hint when the server reports no violations', async () => {
    submit.mockReset();
    submit.mockResolvedValue({ ok: false, error: 'password_policy', violations: [] });
    renderInRoot(<SetPasswordPage locale="fa-IR" mode="invite" token={token} onSubmit={submit} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('رمز عبور جدید'), 'a-brand-new-passphrase');
    await user.type(screen.getByLabelText('تکرار رمز عبور'), 'a-brand-new-passphrase');
    await user.click(screen.getByRole('button', { name: 'ذخیره رمز عبور' }));

    expect(await screen.findByTestId('password-flow-error')).toHaveTextContent(
      'رمز جدید باید حداقل ۱۲ کاراکتر باشد.',
    );
  });

  it('shows a network failure when setting the password fails', async () => {
    submit.mockReset();
    submit.mockResolvedValue({ ok: false, error: 'network' });
    renderInRoot(<SetPasswordPage locale="fa-IR" mode="reset" token={token} onSubmit={submit} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('رمز عبور جدید'), 'a-brand-new-passphrase');
    await user.type(screen.getByLabelText('تکرار رمز عبور'), 'a-brand-new-passphrase');
    await user.click(screen.getByRole('button', { name: 'ذخیره رمز عبور' }));

    expect(await screen.findByTestId('password-flow-error')).toHaveTextContent(
      'ارتباط با سرور برقرار نشد',
    );
  });

  it('renders English labels in LTR', () => {
    renderInRoot(
      <SetPasswordPage
        locale="en-US"
        mode="invite"
        token={token}
        onSubmit={vi.fn().mockResolvedValue({ ok: true })}
      />,
      'en-US',
    );

    expect(screen.getByRole('heading', { name: 'Set your password' })).toBeVisible();
    expect(screen.getByLabelText('Confirm password')).toBeVisible();
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'ltr');
  });
});

describe('VerifyEmailPage', () => {
  it('confirms the token once and never renders it', async () => {
    const token = 'verify-token-value';
    const onConfirm = vi.fn().mockResolvedValue({ ok: true });
    const { container } = renderInRoot(
      <VerifyEmailPage locale="fa-IR" token={token} onConfirm={onConfirm} />,
    );

    expect(await screen.findByTestId('verify-done')).toBeVisible();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(token);
    expect(container.innerHTML).not.toContain(token);
  });

  it('shows a safe invalid state for a rejected token', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: false, error: 'invalid_token' });
    renderInRoot(<VerifyEmailPage locale="fa-IR" token="used-token" onConfirm={onConfirm} />);

    expect(await screen.findByTestId('verify-invalid')).toHaveTextContent(
      'این لینک معتبر نیست یا منقضی شده است',
    );
  });

  it('shows a network state when confirmation cannot reach the API', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: false, error: 'network' });
    renderInRoot(<VerifyEmailPage locale="fa-IR" token="network-token" onConfirm={onConfirm} />);

    expect(await screen.findByTestId('verify-error')).toHaveTextContent(
      'ارتباط با سرور برقرار نشد',
    );
  });

  it('shows the error state when the confirmation throws', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('offline'));
    renderInRoot(<VerifyEmailPage locale="fa-IR" token="throw-token" onConfirm={onConfirm} />);

    expect(await screen.findByTestId('verify-error')).toBeVisible();
  });

  it('does not call the API when the token is missing', () => {
    const onConfirm: (token: string) => Promise<AccountFlowResult> = vi.fn();
    renderInRoot(<VerifyEmailPage locale="fa-IR" token={undefined} onConfirm={onConfirm} />);

    expect(screen.getByTestId('verify-invalid')).toBeVisible();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
