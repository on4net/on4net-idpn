import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IdpnRoot } from './idpn-root';
import { HostedLoginPage, normalizeLoginHint, safeRedirectTarget } from './hosted-login';
import { LoginForm } from './login-form';
import { directionOf, MESSAGES, resolveLocale, translate } from '@/i18n';

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

  it('ships every social login label in both locales', () => {
    const keys = Object.keys(MESSAGES['fa-IR']).filter((key) => key.startsWith('login.social.'));

    expect(keys).toContain('login.social.continueWith');
    expect(keys).toContain('login.social.errorMembershipSuspended');
    for (const key of keys) {
      expect(MESSAGES['en-US'][key], key).toBeTruthy();
    }
    expect(translate('fa-IR', 'login.social.continueWith', { provider: 'Google' })).toBe(
      'ادامه با Google',
    );
    expect(translate('en-US', 'login.social.errorMembershipSuspended')).toBe(
      'Your access to this app is suspended.',
    );
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

  it('prefills the identifier from login_hint', () => {
    renderForm({ defaultIdentifier: 'sara@example.com' });

    expect(screen.getByLabelText('ایمیل یا نام کاربری')).toHaveValue('sara@example.com');
    expect(screen.getByLabelText('رمز عبور')).toHaveValue('');
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
  it('normalizes login hints and caps their length', () => {
    expect(normalizeLoginHint(undefined)).toBeUndefined();
    expect(normalizeLoginHint(null)).toBeUndefined();
    expect(normalizeLoginHint('   ')).toBeUndefined();
    expect(normalizeLoginHint('  sara@example.com ')).toBe('sara@example.com');
    expect(normalizeLoginHint('x'.repeat(300))).toHaveLength(254);
  });

  it('prefills the identifier from a login_hint and submits it', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue({ ok: true });

    render(
      <HostedLoginPage
        search="?client_id=app-a&login_hint=sara%40example.com"
        fetchConfig={vi.fn().mockResolvedValue(null)}
        submit={submit}
        navigate={vi.fn()}
      />,
    );

    const identifier = screen.getByLabelText('ایمیل یا نام کاربری');
    expect(identifier).toHaveValue('sara@example.com');

    await user.type(screen.getByLabelText('رمز عبور'), 'a-very-long-password');
    await user.click(screen.getByRole('button', { name: 'ورود' }));

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: 'sara@example.com',
        password: 'a-very-long-password',
      }),
    );
  });

  it('keeps the identifier editable and empty when login_hint is blank', () => {
    render(
      <HostedLoginPage
        search="?client_id=app-a&login_hint=%20%20"
        fetchConfig={vi.fn().mockResolvedValue(null)}
      />,
    );

    expect(screen.getByLabelText('ایمیل یا نام کاربری')).toHaveValue('');
  });

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
    expect(root.style.getPropertyValue('--idpn-primary')).toBe('#123456');
    expect(root.style.getPropertyValue('--idpn-radius')).toBe('4px');
    expect(root.style.getPropertyValue('--idpn-font-sans')).toContain("'Inter'");
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('drops malicious theme values from the public config', async () => {
    const fetchConfig = vi.fn().mockResolvedValue({
      locale: 'fa-IR',
      locales: { default: 'fa-IR', supported: ['fa-IR'] },
      theme: {
        primary: 'red; } body { display: none',
        background: 'url(javascript:alert(1))',
        radius: '4px; color: red',
      },
    });

    render(<HostedLoginPage search="?client_id=app-a" fetchConfig={fetchConfig} />);

    expect(await screen.findByTestId('public-config-loaded')).toBeInTheDocument();
    const root = screen.getByTestId('idpn-root');
    expect(root.style.getPropertyValue('--idpn-primary')).toBe('');
    expect(root.style.getPropertyValue('--idpn-background')).toBe('');
    expect(root.style.getPropertyValue('--idpn-radius')).toBe('');
    expect(root.getAttribute('style')).not.toMatch(/javascript|color: red|body/i);
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

  it('keeps the password-only layout when the client has no social providers', async () => {
    const fetchConfig = vi.fn().mockResolvedValue({
      locales: { default: 'fa-IR', supported: ['fa-IR'] },
      socialProviders: [],
    });

    render(<HostedLoginPage search="?client_id=app-a" fetchConfig={fetchConfig} />);

    expect(await screen.findByTestId('public-config-loaded')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'ورود با سرویس‌های دیگر' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ورود' })).toBeInTheDocument();
  });

  it('renders one provider button per enabled provider from the public config', async () => {
    const fetchConfig = vi.fn().mockResolvedValue({
      locales: { default: 'fa-IR', supported: ['fa-IR'] },
      socialProviders: [
        { provider: 'google', label: 'Google' },
        { provider: 'facebook', label: 'Facebook' },
      ],
    });

    render(<HostedLoginPage search="?client_id=app-a" fetchConfig={fetchConfig} />);

    expect(await screen.findByRole('button', { name: 'ادامه با Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ادامه با Facebook' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ورود' })).toBeInTheDocument();
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'rtl');
  });

  it('renders a single provider without duplicating or inventing buttons', async () => {
    const fetchConfig = vi.fn().mockResolvedValue({
      locales: { default: 'fa-IR', supported: ['fa-IR'] },
      socialProviders: [{ provider: 'google', label: 'Google' }],
    });

    render(<HostedLoginPage search="?client_id=app-a" fetchConfig={fetchConfig} />);

    expect(await screen.findByRole('button', { name: 'ادامه با Google' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Facebook/ })).not.toBeInTheDocument();
  });

  it('starts social login with the client, provider, return_to and login_hint', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const fetchConfig = vi.fn().mockResolvedValue({
      locales: { default: 'fa-IR', supported: ['fa-IR'] },
      socialProviders: [{ provider: 'google', label: 'Google' }],
    });

    render(
      <HostedLoginPage
        search="?client_id=app-a&return_to=%2Foauth2%2Fauthorize%3Fclient_id%3Dapp-a&login_hint=sara%40example.com&login_request=request-123"
        fetchConfig={fetchConfig}
        navigate={navigate}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'ادامه با Google' }));

    expect(navigate).toHaveBeenCalledTimes(1);
    const target = String(navigate.mock.calls[0]?.[0]);
    const params = new URLSearchParams(target.split('?')[1]);
    expect(target.startsWith('/oauth2/social/app-a/google/start?')).toBe(true);
    expect(params.get('login_request')).toBe('request-123');
    expect(params.get('return_to')).toBe('/oauth2/authorize?client_id=app-a');
    expect(params.get('login_hint')).toBe('sara@example.com');
    expect(target).not.toMatch(/clientKey|secret|scope/i);
  });

  it('hides providers the selected login context does not allow', async () => {
    const fetchConfig = vi.fn().mockResolvedValue({
      locales: { default: 'fa-IR', supported: ['fa-IR'] },
      loginContexts: [{ key: 'team', methods: ['password', 'google'] }],
      socialProviders: [
        { provider: 'google', label: 'Google' },
        { provider: 'facebook', label: 'Facebook' },
      ],
    });

    render(
      <HostedLoginPage search="?client_id=app-a&login_context=team" fetchConfig={fetchConfig} />,
    );

    expect(await screen.findByRole('button', { name: 'ادامه با Google' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Facebook/ })).not.toBeInTheDocument();
  });

  it('shows a translated social error and keeps the password form usable', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue({ ok: true });
    const fetchConfig = vi.fn().mockResolvedValue({
      locales: { default: 'fa-IR', supported: ['fa-IR'] },
      socialProviders: [{ provider: 'google', label: 'Google' }],
    });

    render(
      <HostedLoginPage
        search="?client_id=app-a&error=social_state_invalid"
        fetchConfig={fetchConfig}
        submit={submit}
        navigate={vi.fn()}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('نشست ورود منقضی شده است. دوباره از ابتدا تلاش کنید.');
    expect(alert).not.toHaveTextContent('social_state_invalid');

    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara');
    await user.type(screen.getByLabelText('رمز عبور'), 'a-very-long-password');
    await user.click(screen.getByRole('button', { name: 'ورود' }));

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'sara', password: 'a-very-long-password' }),
    );
  });

  it('never renders an unknown error value from the query string', () => {
    render(
      <HostedLoginPage
        search="?client_id=app-a&error=%3Cscript%3Ealert(1)%3C%2Fscript%3E"
        fetchConfig={vi.fn().mockResolvedValue(null)}
      />,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  it('never navigates to the raw return_to query value', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const submit = vi.fn().mockResolvedValue({ ok: true });

    render(
      <HostedLoginPage
        search="?client_id=app-a&return_to=javascript%3Aalert(document.domain)"
        fetchConfig={vi.fn().mockResolvedValue(null)}
        submit={submit}
        navigate={navigate}
      />,
    );

    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara');
    await user.type(screen.getByLabelText('رمز عبور'), 'a-very-long-password');
    await user.click(screen.getByRole('button', { name: 'ورود' }));

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('rejects protocol-relative and off-site redirect targets', () => {
    expect(safeRedirectTarget(undefined)).toBe('/');
    expect(safeRedirectTarget('//evil.example/login')).toBe('/');
    expect(safeRedirectTarget('/\\evil.example')).toBe('/');
    expect(safeRedirectTarget('javascript:alert(1)')).toBe('/');
    expect(safeRedirectTarget('https://evil.example/oauth2/authorize')).toBe('/');
    expect(safeRedirectTarget('/oauth2/authorize?client_id=app-a')).toBe(
      '/oauth2/authorize?client_id=app-a',
    );
    expect(safeRedirectTarget(`${window.location.origin}/oauth2/authorize`)).toBe(
      `${window.location.origin}/oauth2/authorize`,
    );
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
    expect(screen.getByTestId('idpn-root').style.getPropertyValue('--idpn-primary')).toBe(
      '#abcdef',
    );

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

describe('HostedLoginPage MFA step', () => {
  const challenge = {
    ok: false as const,
    reason: 'mfa_required' as const,
    challengeToken: 'challenge-token-value-1234567890',
  };

  const submitWithPassword = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara@example.com');
    await user.type(screen.getByLabelText('رمز عبور'), 'a-very-long-password');
    await user.click(screen.getByRole('button', { name: 'ورود' }));
  };

  const renderWith = (
    verify: ComponentProps<typeof HostedLoginPage>['verify'],
    navigate = vi.fn(),
  ) =>
    render(
      <HostedLoginPage
        search="?client_id=app-a&return_to=%2Foauth2%2Fauthorize%3Fclient_id%3Dapp-a"
        fetchConfig={vi.fn().mockResolvedValue(null)}
        submit={vi.fn().mockResolvedValue(challenge)}
        verify={verify}
        navigate={navigate}
      />,
    );

  it('shows the one-time-code step after the password and completes the login', async () => {
    const user = userEvent.setup();
    const verify = vi
      .fn()
      .mockResolvedValue({ ok: true, redirectTo: '/oauth2/authorize?client_id=app-a' });
    const navigate = vi.fn();
    renderWith(verify, navigate);

    await submitWithPassword(user);

    expect(await screen.findByRole('heading', { name: 'ورود دومرحله‌ای' })).toBeVisible();
    const input = screen.getByLabelText('کد ۶ رقمی');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('dir', 'ltr');

    await user.type(input, '123456');
    await user.click(screen.getByRole('button', { name: 'تأیید و ورود' }));

    expect(verify).toHaveBeenCalledWith({
      challengeToken: challenge.challengeToken,
      code: '123456',
      method: 'totp',
    });
    expect(navigate).toHaveBeenCalledWith('/oauth2/authorize?client_id=app-a');
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'rtl');
  });

  it('offers the passkey second factor when the login response lists webauthn', async () => {
    const user = userEvent.setup();
    const verifyPasskey = vi
      .fn()
      .mockResolvedValue({ ok: true, redirectTo: '/oauth2/authorize?client_id=app-a' });
    const navigate = vi.fn();
    const driver = {
      supported: vi.fn().mockReturnValue(true),
      register: vi.fn(),
      authenticate: vi.fn(),
    };
    render(
      <HostedLoginPage
        search="?client_id=app-a&return_to=%2Foauth2%2Fauthorize%3Fclient_id%3Dapp-a"
        fetchConfig={vi.fn().mockResolvedValue(null)}
        submit={vi.fn().mockResolvedValue({ ...challenge, methods: ['totp', 'webauthn'] })}
        verify={vi.fn()}
        verifyPasskey={verifyPasskey}
        passkeys={driver}
        navigate={navigate}
      />,
    );

    await submitWithPassword(user);

    const passkey = await screen.findByTestId('mfa-passkey');
    expect(passkey).toHaveTextContent('ورود با Passkey');
    await user.click(passkey);

    expect(verifyPasskey).toHaveBeenCalledWith({
      challengeToken: challenge.challengeToken,
      driver,
    });
    expect(navigate).toHaveBeenCalledWith('/oauth2/authorize?client_id=app-a');
  });

  it('does not offer a passkey button when the account has no passkey', async () => {
    const user = userEvent.setup();
    renderWith(vi.fn());
    await submitWithPassword(user);
    await screen.findByRole('heading', { name: 'ورود دومرحله‌ای' });
    expect(screen.queryByTestId('mfa-passkey')).toBeNull();
    expect(screen.getByRole('button', { name: 'تأیید و ورود' })).toBeVisible();
  });

  it('switches to a recovery code and normalizes formatting', async () => {
    const user = userEvent.setup();
    const verify = vi.fn().mockResolvedValue({ ok: true });
    renderWith(verify);

    await submitWithPassword(user);
    await user.click(await screen.findByRole('button', { name: 'استفاده از کد بازیابی' }));

    const input = screen.getByLabelText('کد بازیابی');
    expect(screen.getByText('کد بازیابی ۱۰ کاراکتری را با خط تیره وارد کنید.')).toBeVisible();
    await user.type(input, 'abcde-fghjk');
    await user.click(screen.getByRole('button', { name: 'تأیید و ورود' }));

    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'abcde-fghjk', method: 'recovery' }),
    );
  });

  it('validates the code before calling the API', async () => {
    const user = userEvent.setup();
    const verify = vi.fn();
    renderWith(verify);

    await submitWithPassword(user);
    await user.click(await screen.findByRole('button', { name: 'تأیید و ورود' }));
    expect(screen.getByText('کد تأیید را وارد کنید.')).toBeVisible();

    await user.type(screen.getByLabelText('کد ۶ رقمی'), '12');
    await user.click(screen.getByRole('button', { name: 'تأیید و ورود' }));
    expect(screen.getByText('کد باید ۶ رقم باشد.')).toBeVisible();
    expect(verify).not.toHaveBeenCalled();
  });

  it('announces an invalid code and a rate-limited challenge', async () => {
    const user = userEvent.setup();
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'invalid_code' })
      .mockResolvedValueOnce({ ok: false, reason: 'rate_limited' });
    renderWith(verify);

    await submitWithPassword(user);
    const input = await screen.findByLabelText('کد ۶ رقمی');
    await user.type(input, '000000');
    await user.click(screen.getByRole('button', { name: 'تأیید و ورود' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('کد واردشده معتبر نیست.');
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');

    await user.click(screen.getByRole('button', { name: 'تأیید و ورود' }));
    expect(
      await screen.findByText('تلاش‌های ناموفق بیش از حد بود. دوباره وارد شوید.'),
    ).toBeVisible();
  });

  it('explains an expired challenge without pretending the code was wrong', async () => {
    const user = userEvent.setup();
    renderWith(vi.fn().mockResolvedValue({ ok: false, reason: 'expired' }));

    await submitWithPassword(user);
    await user.type(await screen.findByLabelText('کد ۶ رقمی'), '123456');
    await user.click(screen.getByRole('button', { name: 'تأیید و ورود' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'زمان این ورود به پایان رسیده است. دوباره وارد شوید.',
    );
  });

  it('returns to the password step and drops the challenge token', async () => {
    const user = userEvent.setup();
    renderWith(vi.fn());

    await submitWithPassword(user);
    await user.click(await screen.findByRole('button', { name: 'بازگشت به ورود' }));

    expect(screen.getByRole('heading', { name: 'ورود به حساب' })).toBeVisible();
    expect(screen.queryByLabelText('کد ۶ رقمی')).toBeNull();
  });

  it('tells the user when the policy requires enrollment', async () => {
    const user = userEvent.setup();
    render(
      <HostedLoginPage
        search="?client_id=app-required"
        fetchConfig={vi.fn().mockResolvedValue(null)}
        submit={vi.fn().mockResolvedValue({ ok: false, reason: 'mfa_enrollment_required' })}
        navigate={vi.fn()}
      />,
    );

    await submitWithPassword(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'برای این حساب ورود دومرحله‌ای الزامی است. ابتدا آن را در بخش امنیت حساب فعال کنید.',
    );
  });
});

describe('HostedLoginPage default API calls', () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const stubFetch = (
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)),
    );
  };

  const signIn = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara@example.com');
    await user.type(screen.getByLabelText('رمز عبور'), 'a-very-long-password');
    await user.click(screen.getByRole('button', { name: 'ورود' }));
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('turns a challenge response into the second-factor step', async () => {
    const user = userEvent.setup();
    stubFetch((url) =>
      url.includes('/public-config')
        ? jsonResponse({}, 404)
        : jsonResponse({ ok: false, mfa: 'challenge', challengeToken: 'token-from-api' }),
    );
    render(<HostedLoginPage search="?client_id=app-a" navigate={vi.fn()} />);

    await signIn(user);

    expect(await screen.findByRole('heading', { name: 'ورود دومرحله‌ای' })).toBeVisible();
  });

  it('shows the enrollment-required message for a 403 with that code', async () => {
    const user = userEvent.setup();
    stubFetch((url) =>
      url.includes('/public-config')
        ? jsonResponse({}, 404)
        : jsonResponse({ error: 'mfa_enrollment_required' }, 403),
    );
    render(<HostedLoginPage search="?client_id=app-a" navigate={vi.fn()} />);

    await signIn(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'برای این حساب ورود دومرحله‌ای الزامی است. ابتدا آن را در بخش امنیت حساب فعال کنید.',
    );
  });

  it('reports any other 403 as a network error', async () => {
    const user = userEvent.setup();
    stubFetch((url) =>
      url.includes('/public-config')
        ? jsonResponse({}, 404)
        : jsonResponse({ error: 'forbidden' }, 403),
    );
    render(<HostedLoginPage search="?client_id=app-a" navigate={vi.fn()} />);

    await signIn(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.',
    );
  });

  it('completes the login with the verify endpoint and follows redirectTo', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    stubFetch((url) => {
      if (url.includes('/public-config')) {
        return jsonResponse({}, 404);
      }
      if (url.endsWith('/api/v1/login/mfa/verify')) {
        return jsonResponse({ ok: true, redirectTo: '/oauth2/authorize?client_id=app-a' });
      }
      return jsonResponse({ ok: false, mfa: 'challenge', challengeToken: 'token-from-api' });
    });
    render(<HostedLoginPage search="?client_id=app-a" navigate={navigate} />);

    await signIn(user);
    await user.type(await screen.findByLabelText('کد ۶ رقمی'), '123456');
    await user.click(screen.getByRole('button', { name: 'تأیید و ورود' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/oauth2/authorize?client_id=app-a'));
  });

  it.each([
    [429, { error: 'mfa_rate_limited' }, 'تلاش‌های ناموفق بیش از حد بود. دوباره وارد شوید.'],
    [400, { error: 'invalid_request' }, 'کد واردشده معتبر نیست.'],
    [
      401,
      { error: 'mfa_challenge_invalid' },
      'زمان این ورود به پایان رسیده است. دوباره وارد شوید.',
    ],
    [401, { error: 'invalid_mfa_code' }, 'کد واردشده معتبر نیست.'],
  ])('maps a %i verify failure to a safe message', async (status, body, message) => {
    const user = userEvent.setup();
    stubFetch((url) => {
      if (url.includes('/public-config')) {
        return jsonResponse({}, 404);
      }
      if (url.endsWith('/api/v1/login/mfa/verify')) {
        return jsonResponse(body, status);
      }
      return jsonResponse({ ok: false, mfa: 'challenge', challengeToken: 'token-from-api' });
    });
    render(<HostedLoginPage search="?client_id=app-a" navigate={vi.fn()} />);

    await signIn(user);
    await user.type(await screen.findByLabelText('کد ۶ رقمی'), '123456');
    await user.click(screen.getByRole('button', { name: 'تأیید و ورود' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });
});

describe('HostedLoginPage account flows', () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const stubFetch = (
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)),
    );
  };

  it('routes action=forgot-password to the neutral request form', async () => {
    const forgotPassword = vi.fn().mockResolvedValue({ ok: true });
    render(
      <HostedLoginPage
        search="?client_id=app-a&action=forgot-password"
        fetchConfig={vi.fn().mockResolvedValue(null)}
        forgotPassword={forgotPassword}
      />,
    );

    expect(screen.getByRole('heading', { name: 'بازیابی رمز عبور' })).toBeVisible();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara@example.com');
    await user.click(screen.getByRole('button', { name: 'ارسال لینک' }));

    expect(forgotPassword).toHaveBeenCalledWith('sara@example.com');
    expect(await screen.findByTestId('forgot-sent')).toHaveTextContent(
      'اگر این ایمیل در سیستم موجود باشد',
    );
  });

  it('routes action=reset-password to the token form without rendering the token', async () => {
    const setPassword = vi.fn().mockResolvedValue({ ok: true });
    const token = 'reset-token-in-query';
    const { container } = render(
      <HostedLoginPage
        search={`?action=reset-password&token=${token}&ui_locales=en-US`}
        fetchConfig={vi.fn().mockResolvedValue(null)}
        setPassword={setPassword}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    expect(container.innerHTML).not.toContain(token);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New password'), 'a-brand-new-passphrase');
    await user.type(screen.getByLabelText('Confirm password'), 'a-brand-new-passphrase');
    await user.click(screen.getByRole('button', { name: 'Save password' }));

    expect(setPassword).toHaveBeenCalledWith({
      token,
      password: 'a-brand-new-passphrase',
      mode: 'reset',
    });
    expect(await screen.findByTestId('password-done')).toBeVisible();
  });

  it('routes action=verify-email to a one-shot confirmation', async () => {
    const confirmEmail = vi.fn().mockResolvedValue({ ok: true });
    render(
      <HostedLoginPage
        search="?action=verify-email&token=verify-token"
        fetchConfig={vi.fn().mockResolvedValue(null)}
        confirmEmail={confirmEmail}
      />,
    );

    expect(await screen.findByTestId('verify-done')).toBeVisible();
    expect(confirmEmail).toHaveBeenCalledWith('verify-token');
  });

  it('keeps client parameters in the forgot-password link', () => {
    render(
      <HostedLoginPage
        search="?client_id=app-a&ui_locales=fa-IR&login_hint=sara%40example.com"
        fetchConfig={vi.fn().mockResolvedValue(null)}
      />,
    );

    const link = screen.getByRole('link', { name: 'رمز عبور را فراموش کرده‌اید؟' });
    const href = link.getAttribute('href') ?? '';
    const params = new URLSearchParams(href.replace(/^\?/, ''));
    expect(params.get('action')).toBe('forgot-password');
    expect(params.get('client_id')).toBe('app-a');
    expect(params.get('ui_locales')).toBe('fa-IR');
  });

  it.each([
    [202, null, 'اگر این ایمیل در سیستم موجود باشد'],
    [429, null, 'تلاش‌های شما بیش از حد بود'],
    [500, null, 'ارتباط با سرور برقرار نشد'],
  ] as const)(
    'maps the default forgot endpoint (%i) to a safe state',
    async (status, _body, text) => {
      stubFetch((url) => {
        if (url.includes('/public-config')) {
          return jsonResponse({}, 404);
        }
        if (url.endsWith('/api/v1/account/password/forgot')) {
          return jsonResponse({ status: 'accepted' }, status);
        }
        return jsonResponse({}, 404);
      });
      render(<HostedLoginPage search="?action=forgot-password&ui_locales=fa-IR" />);

      const user = userEvent.setup();
      await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara@example.com');
      await user.click(screen.getByRole('button', { name: 'ارسال لینک' }));

      if (status === 202) {
        expect(await screen.findByTestId('forgot-sent')).toHaveTextContent(text);
      } else {
        expect(await screen.findByRole('alert')).toHaveTextContent(text);
      }
    },
  );

  it('maps a network failure of the forgot endpoint to a safe state', async () => {
    stubFetch((url) => {
      if (url.includes('/public-config')) {
        return jsonResponse({}, 404);
      }
      throw new Error('offline');
    });
    render(<HostedLoginPage search="?action=forgot-password&ui_locales=fa-IR" />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara@example.com');
    await user.click(screen.getByRole('button', { name: 'ارسال لینک' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ارتباط با سرور برقرار نشد');
  });

  it.each([
    [400, {}, 'این لینک معتبر نیست یا منقضی شده است'],
    [429, {}, 'تلاش‌های شما بیش از حد بود'],
    [422, { code: 'password_policy', violations: ['common_password'] }, 'این رمز رایج است'],
    [422, { code: 'other' }, 'خطای غیرمنتظره رخ داد'],
    [500, {}, 'ارتباط با سرور برقرار نشد'],
  ] as const)(
    'maps the default reset endpoint (%i) to a safe state',
    async (status, body, text) => {
      stubFetch((url) => {
        if (url.includes('/public-config')) {
          return jsonResponse({}, 404);
        }
        if (url.endsWith('/api/v1/account/password/reset')) {
          return jsonResponse(body, status);
        }
        return jsonResponse({}, 404);
      });
      render(
        <HostedLoginPage search="?action=reset-password&token=abc-token-value&ui_locales=fa-IR" />,
      );

      const user = userEvent.setup();
      await user.type(screen.getByLabelText('رمز عبور جدید'), 'a-brand-new-passphrase');
      await user.type(screen.getByLabelText('تکرار رمز عبور'), 'a-brand-new-passphrase');
      await user.click(screen.getByRole('button', { name: 'ذخیره رمز عبور' }));

      expect(await screen.findByTestId('password-flow-error')).toHaveTextContent(text);
    },
  );

  it('confirms a reset through the default endpoint', async () => {
    stubFetch((url) => {
      if (url.includes('/public-config')) {
        return jsonResponse({}, 404);
      }
      return jsonResponse({ ok: true });
    });
    render(
      <HostedLoginPage search="?action=reset-password&token=abc-token-value&ui_locales=fa-IR" />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('رمز عبور جدید'), 'a-brand-new-passphrase');
    await user.type(screen.getByLabelText('تکرار رمز عبور'), 'a-brand-new-passphrase');
    await user.click(screen.getByRole('button', { name: 'ذخیره رمز عبور' }));

    expect(await screen.findByTestId('password-done')).toBeVisible();
  });

  it.each([
    [200, 'verify-done'],
    [400, 'verify-invalid'],
    [500, 'verify-error'],
  ] as const)('maps the default verify endpoint (%i)', async (status, testId) => {
    stubFetch((url) => {
      if (url.includes('/public-config')) {
        return jsonResponse({}, 404);
      }
      return jsonResponse({ ok: status === 200 }, status);
    });
    render(<HostedLoginPage search="?action=verify-email&token=verify-token&ui_locales=fa-IR" />);

    expect(await screen.findByTestId(testId)).toBeVisible();
  });

  it('maps a thrown verification request to the error state', async () => {
    stubFetch((url) => {
      if (url.includes('/public-config')) {
        return jsonResponse({}, 404);
      }
      throw new Error('offline');
    });
    render(<HostedLoginPage search="?action=verify-email&token=verify-token&ui_locales=fa-IR" />);

    expect(await screen.findByTestId('verify-error')).toBeVisible();
  });
});
