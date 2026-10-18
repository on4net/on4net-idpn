import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { IdpnRoot } from './idpn-root';
import { LoginPage } from './login-page';

function renderLogin() {
  return render(
    <IdpnRoot locale="fa-IR" dir="rtl">
      <LoginPage />
    </IdpnRoot>,
  );
}

describe('LoginPage', () => {
  it('renders the Persian login form in RTL with labelled fields', () => {
    renderLogin();

    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('heading', { name: 'ورود به حساب' })).toBeInTheDocument();
    expect(screen.getByLabelText('ایمیل')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('رمز عبور')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'ورود' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'نوع ورود' })).toBeInTheDocument();
  });

  it('wires validation errors to their inputs', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole('button', { name: 'ورود' }));

    const emailError = await screen.findByText('ایمیل یا نام کاربری را وارد کنید');
    const emailInput = screen.getByLabelText('ایمیل');

    expect(emailError).toHaveAttribute('role', 'alert');
    expect(emailInput).toHaveAttribute('aria-invalid', 'true');
    expect(emailInput).toHaveAttribute('aria-describedby', 'identifier-error');
  });

  it('rejects a password shorter than eight characters', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText('ایمیل'), 'admin@example.com');
    await user.type(screen.getByLabelText('رمز عبور'), 'short');
    await user.click(screen.getByRole('button', { name: 'ورود' }));

    expect(await screen.findByText('رمز عبور باید حداقل ۸ کاراکتر باشد')).toBeInTheDocument();
  });

  it('accepts valid credentials', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText('ایمیل'), 'admin@example.com');
    await user.type(screen.getByLabelText('رمز عبور'), 'correct-horse');
    await user.click(screen.getByRole('button', { name: 'ورود' }));

    expect(await screen.findByRole('status')).toHaveTextContent('درخواست ورود ثبت شد.');
  });

  it('opens the help dialog from the keyboard and closes it with Escape', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole('button', { name: 'رمز عبور را فراموش کرده‌اید؟' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('بازیابی رمز عبور');
    expect(dialog).toHaveAccessibleDescription('لینک بازیابی به ایمیل ثبت‌شده ارسال می‌شود.');
    expect(screen.getByTestId('idpn-portal-root')).toContainElement(dialog);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
