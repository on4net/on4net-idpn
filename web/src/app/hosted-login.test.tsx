import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { IdpnRoot } from './idpn-root';
import { HostedLoginPage } from './hosted-login';
import { LoginForm } from './login-form';
import { directionOf, resolveLocale, translate } from '@/i18n';

function renderForm(overrides: Partial<React.ComponentProps<typeof LoginForm>> = {}) {
  return render(
    <IdpnRoot locale="fa-IR" dir="rtl">
      <LoginForm
        locale="fa-IR"
        dir="rtl"
        submitting={false}
        errorCode={null}
        onSubmit={vi.fn()}
        {...overrides}
      />
    </IdpnRoot>,
  );
}

describe('i18n', () => {
  it('resolves ui_locales against the client locales, then the default', () => {
    expect(resolveLocale('en-US fa-IR', ['fa-IR', 'en-US'])).toBe('en-US');
    expect(resolveLocale('en', ['fa-IR', 'en-US'])).toBe('en-US');
    expect(resolveLocale('de-DE', ['fa-IR', 'en-US'])).toBe('fa-IR');
    expect(resolveLocale(undefined, ['fa-IR', 'en-US'], 'en-US')).toBe('en-US');
    expect(resolveLocale(undefined, ['fa-IR'])).toBe('fa-IR');
  });

  it('derives direction from the locale', () => {
    expect(directionOf('fa-IR')).toBe('rtl');
    expect(directionOf('ar-SA')).toBe('rtl');
    expect(directionOf('en-US')).toBe('ltr');
  });

  it('translates and falls back to Persian', () => {
    expect(translate('fa-IR', 'login.title')).toBe('ورود به حساب');
    expect(translate('en-US', 'login.title')).toBe('Sign in');
    expect(translate('en-US', 'missing.key')).toBe('missing.key');
  });

  it('interpolates values into placeholders', () => {
    expect(translate('en-US', 'login.title', { unused: 1 })).toBe('Sign in');
    expect(translate('fa-IR', 'common.loading')).toBe('در حال بارگذاری');
  });
});

describe('LoginForm', () => {
  it('renders localized labels in RTL with autofocus on the identifier', () => {
    renderForm();

    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('heading', { name: 'ورود به حساب' })).toBeInTheDocument();
    const identifier = screen.getByLabelText('ایمیل یا نام کاربری');
    expect(identifier).toHaveFocus();
    expect(screen.getByLabelText('رمز عبور')).toHaveAttribute('type', 'password');
  });

  it('renders in LTR with English messages', () => {
    renderForm({ locale: 'en-US', dir: 'ltr' });

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email or username')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('validates empty fields and links the error to the input', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'ورود' }));

    const identifier = screen.getByLabelText('ایمیل یا نام کاربری');
    expect(await screen.findByText('ایمیل یا نام کاربری را وارد کنید.')).toBeInTheDocument();
    expect(identifier).toHaveAttribute('aria-invalid', 'true');
    expect(identifier).toHaveAttribute('aria-describedby', 'identifier-error');
  });

  it('shows a generic invalid-credentials message from the server', () => {
    renderForm({ errorCode: 'invalid_credentials' });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('نام کاربری یا رمز عبور نادرست است.');
    expect(alert.textContent).not.toMatch(/exist|وجود ندارد|یافت نشد/i);
  });

  it('shows a network error when the API is unreachable', () => {
    renderForm({ errorCode: 'network' });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.',
    );
  });

  it('disables the submit button and announces progress while submitting', () => {
    renderForm({ submitting: true });

    const button = screen.getByRole('button', { name: /در حال ورود/ });
    expect(button).toBeDisabled();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('submits the entered credentials', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderForm({ onSubmit });

    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara@example.com');
    await user.type(screen.getByLabelText('رمز عبور'), 'a-very-long-password');
    await user.click(screen.getByRole('button', { name: 'ورود' }));

    expect(onSubmit).toHaveBeenCalledWith({
      identifier: 'sara@example.com',
      password: 'a-very-long-password',
    });
  });
});

describe('HostedLoginPage', () => {
  it('applies the client theme and locale from the public config', async () => {
    const fetchConfig = vi.fn().mockResolvedValue({
      locale: 'fa-IR',
      locales: { default: 'en-US', supported: ['fa-IR', 'en-US'] },
      theme: { primary: '#123456', radius: '4px' },
    });

    render(
      <HostedLoginPage search="?client_id=app-a&ui_locales=en-US" fetchConfig={fetchConfig} />,
    );

    expect(await screen.findByTestId('public-config-loaded')).toBeInTheDocument();
    const root = screen.getByTestId('idpn-root');
    expect(root).toHaveAttribute('dir', 'ltr');
    expect(root).toHaveAttribute('data-client-id', 'app-a');
    expect(root.style.getPropertyValue('--primary')).toBe('#123456');
    expect(root.style.getPropertyValue('--idpn-primary')).toBe('#123456');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('falls back to defaults when the public config is unavailable', async () => {
    const fetchConfig = vi.fn().mockRejectedValue(new Error('offline'));

    render(<HostedLoginPage search="?client_id=app-a" fetchConfig={fetchConfig} />);

    const root = screen.getByTestId('idpn-root');
    expect(root).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('heading', { name: 'ورود به حساب' })).toBeInTheDocument();
  });

  it('falls back to defaults when the client is not public', async () => {
    const fetchConfig = vi.fn().mockResolvedValue(null);

    render(<HostedLoginPage search="?client_id=unknown" fetchConfig={fetchConfig} />);

    expect(screen.getByRole('heading', { name: 'ورود به حساب' })).toBeInTheDocument();
    expect(screen.queryByTestId('public-config-loaded')).not.toBeInTheDocument();
  });

  it('accepts redirect_uri as a return target', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue({ ok: true });

    render(
      <HostedLoginPage
        search="?client_id=app-a&redirect_uri=https%3A%2F%2Fapp-a.example.com%2Fcb"
        fetchConfig={vi.fn().mockResolvedValue(null)}
        submit={submit}
        navigate={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara');
    await user.type(screen.getByLabelText('رمز عبور'), 'a-very-long-password');
    await user.click(screen.getByRole('button', { name: 'ورود' }));

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ returnTo: 'https://app-a.example.com/cb' }),
    );
  });

  it('navigates to the redirect target returned by the API', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const submit = vi.fn().mockResolvedValue({ ok: true, redirectTo: '/oauth2/authorize?x=1' });

    render(
      <HostedLoginPage
        search="?client_id=app-a&return_to=%2Foauth2%2Fauthorize"
        fetchConfig={vi.fn().mockResolvedValue(null)}
        submit={submit}
        navigate={navigate}
      />,
    );

    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara');
    await user.type(screen.getByLabelText('رمز عبور'), 'a-very-long-password');
    await user.click(screen.getByRole('button', { name: 'ورود' }));

    expect(submit).toHaveBeenCalledWith({
      identifier: 'sara',
      password: 'a-very-long-password',
      clientId: 'app-a',
      returnTo: '/oauth2/authorize',
    });
    expect(navigate).toHaveBeenCalledWith('/oauth2/authorize?x=1');
  });

  it('shows the secure error and does not navigate on failure', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const submit = vi.fn().mockResolvedValue({ ok: false, reason: 'invalid_credentials' });

    render(
      <HostedLoginPage
        search="?"
        fetchConfig={vi.fn().mockResolvedValue(null)}
        submit={submit}
        navigate={navigate}
      />,
    );

    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara');
    await user.type(screen.getByLabelText('رمز عبور'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'ورود' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'نام کاربری یا رمز عبور نادرست است.',
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('uses the built-in fetchers against the API endpoints', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/public-config')) {
        return new Response(
          JSON.stringify({
            locales: { default: 'fa-IR', supported: ['fa-IR'] },
            theme: { primary: '#abcdef' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/v1/login')) {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ ok: true, redirectTo: '/done' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<HostedLoginPage search="?client_id=app-a" navigate={vi.fn()} />);

    expect(await screen.findByTestId('public-config-loaded')).toBeInTheDocument();
    expect(screen.getByTestId('idpn-root').style.getPropertyValue('--primary')).toBe('#abcdef');

    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara');
    await user.type(screen.getByLabelText('رمز عبور'), 'a-very-long-password');
    await user.click(screen.getByRole('button', { name: 'ورود' }));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/login',
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });

  it('reports a network failure when the login request rejects', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/public-config')) {
        return new Response('not found', { status: 404 });
      }
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<HostedLoginPage search="?client_id=app-a" navigate={vi.fn()} />);
    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara');
    await user.type(screen.getByLabelText('رمز عبور'), 'a-very-long-password');
    await user.click(screen.getByRole('button', { name: 'ورود' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.',
    );
    vi.unstubAllGlobals();
  });
});
