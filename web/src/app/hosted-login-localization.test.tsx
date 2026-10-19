import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IDPN_MFE_EVENT_NAME, type IdpnEvent } from '@idpn/mfe-sdk';

import { HostedLoginPage } from './hosted-login';

const CONFIG = {
  locale: 'fa-IR',
  locales: {
    default: 'fa-IR',
    supported: ['fa-IR', 'en-US'],
    dir: { 'fa-IR': 'rtl' as const, 'en-US': 'ltr' as const },
  },
  translationsUrl: '/api/v1/clients/app-a/translations/bundle',
  theme: { primary: '#0057b8', radius: '8px' },
};

const translations = (overrides: Record<string, string>, locale: 'fa-IR' | 'en-US' = 'fa-IR') =>
  vi.fn().mockResolvedValue({
    locale,
    dir: locale === 'fa-IR' ? 'rtl' : 'ltr',
    messages: overrides,
  });

async function waitForForm(): Promise<void> {
  await waitFor(() =>
    expect(screen.queryByTestId('hosted-login-skeleton')).not.toBeInTheDocument(),
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('Hosted login client locale bootstrap', () => {
  it('shows a neutral skeleton until the public config resolves', async () => {
    let resolveConfig: ((value: typeof CONFIG | null) => void) | undefined;
    const fetchConfig = vi.fn(
      () =>
        new Promise<typeof CONFIG | null>((resolve) => {
          resolveConfig = resolve;
        }),
    );

    render(
      <HostedLoginPage
        search="?client_id=app-a&ui_locales=fa-IR"
        fetchConfig={fetchConfig}
        fetchBundle={translations({})}
      />,
    );

    expect(screen.getByTestId('hosted-login-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('data-config-state', 'loading');
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('heading', { name: 'ورود به حساب' })).not.toBeInTheDocument();

    resolveConfig?.(CONFIG);
    await waitForForm();

    expect(screen.getByRole('heading', { name: 'ورود به حساب' })).toBeInTheDocument();
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('data-config-state', 'ready');
  });

  it('applies the resolved locale, direction and per-locale font stack', async () => {
    const fetchConfig = vi.fn().mockResolvedValue(CONFIG);
    render(
      <HostedLoginPage
        search="?client_id=app-a&ui_locales=en-US"
        fetchConfig={fetchConfig}
        fetchBundle={translations({}, 'en-US')}
      />,
    );
    await waitForForm();

    const root = screen.getByTestId('idpn-root');
    expect(root).toHaveAttribute('lang', 'en-US');
    expect(root).toHaveAttribute('dir', 'ltr');
    expect(root.style.getPropertyValue('--idpn-font-sans')).toContain("'Inter'");
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('keeps Vazirmatn for fa-IR even when the client overrides its direction', async () => {
    const fetchConfig = vi.fn().mockResolvedValue({
      ...CONFIG,
      locales: {
        default: 'fa-IR',
        supported: ['fa-IR'],
        dir: { 'fa-IR': 'ltr' },
      },
    });
    render(<HostedLoginPage search="?client_id=app-a" fetchConfig={fetchConfig} />);
    await waitForForm();

    const root = screen.getByTestId('idpn-root');
    expect(root).toHaveAttribute('dir', 'ltr');
    expect(root.style.getPropertyValue('--idpn-font-sans')).toContain("'Vazirmatn'");
  });

  it('falls back to the default locale and base bundle when the config fails', async () => {
    const fetchBundle = vi.fn();
    render(
      <HostedLoginPage
        search="?client_id=app-a"
        fetchConfig={vi.fn().mockRejectedValue(new Error('offline'))}
        fetchBundle={fetchBundle}
      />,
    );
    await waitForForm();

    const root = screen.getByTestId('idpn-root');
    expect(root).toHaveAttribute('data-config-state', 'error');
    expect(root).toHaveAttribute('lang', 'fa-IR');
    expect(root).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('heading', { name: 'ورود به حساب' })).toBeInTheDocument();
    // No translationsUrl was discovered, so no bundle request is attempted.
    expect(fetchBundle).not.toHaveBeenCalled();
  });

  it('uses the base bundle when the translations bundle fails', async () => {
    render(
      <HostedLoginPage
        search="?client_id=app-a&ui_locales=fa-IR"
        fetchConfig={vi.fn().mockResolvedValue(CONFIG)}
        fetchBundle={vi.fn().mockRejectedValue(new Error('404'))}
      />,
    );
    await waitForForm();

    const root = screen.getByTestId('idpn-root');
    expect(root).toHaveAttribute('data-bundle-state', 'error');
    expect(screen.getByRole('heading', { name: 'ورود به حساب' })).toBeInTheDocument();
    expect(screen.getByLabelText('ایمیل یا نام کاربری')).toBeInTheDocument();
  });

  it('applies client overrides and keeps the base text for missing keys', async () => {
    render(
      <HostedLoginPage
        search="?client_id=app-a&ui_locales=en-US"
        fetchConfig={vi.fn().mockResolvedValue(CONFIG)}
        fetchBundle={translations({ 'login.title': 'Customer portal sign-in' }, 'en-US')}
      />,
    );
    await waitForForm();

    expect(screen.getByRole('heading', { name: 'Customer portal sign-in' })).toBeInTheDocument();
    // The override only replaces one key; the shared base fills the rest.
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('ignores unknown keys and unsafe values from the bundle', async () => {
    const fetchBundle = vi.fn().mockResolvedValue({
      messages: {
        'unknown.key': 'must not render',
        'login.title': 'ورود امن',
        'login.password': '<script>alert(1)</script>',
      },
    });
    render(
      <HostedLoginPage
        search="?client_id=app-a&ui_locales=fa-IR"
        fetchConfig={vi.fn().mockResolvedValue(CONFIG)}
        fetchBundle={fetchBundle}
      />,
    );
    await waitForForm();

    expect(screen.getByRole('heading', { name: 'ورود امن' })).toBeInTheDocument();
    expect(screen.queryByText('must not render')).not.toBeInTheDocument();
    // React renders the string as text; it is never interpreted as markup.
    expect(screen.getByLabelText('رمز عبور')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });

  it('never offers a locale without a shipped base bundle', async () => {
    const fetchConfig = vi.fn().mockResolvedValue({
      ...CONFIG,
      locales: {
        default: 'fa-IR',
        supported: ['fa-IR', 'de-DE'],
        dir: { 'fa-IR': 'rtl', 'de-DE': 'ltr' },
      },
    });
    render(
      <HostedLoginPage
        search="?client_id=app-a&ui_locales=de-DE"
        fetchConfig={fetchConfig}
        fetchBundle={translations({})}
      />,
    );
    await waitForForm();

    expect(screen.queryByTestId('language-switcher')).not.toBeInTheDocument();
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('lang', 'fa-IR');
    expect(screen.getByRole('heading', { name: 'ورود به حساب' })).toBeInTheDocument();
  });
});

describe('Hosted login language switch', () => {
  it('switches locale, direction, bundle and formatting without losing the form or return_to', async () => {
    const user = userEvent.setup();
    const fetchBundle = vi.fn(async ({ locale }: { locale: 'fa-IR' | 'en-US' }) =>
      locale === 'en-US'
        ? { locale, messages: { 'login.title': 'Customer portal sign-in' } }
        : { locale, messages: {} },
    );
    const events: IdpnEvent[] = [];
    const listener = (event: Event): void => {
      events.push((event as CustomEvent<IdpnEvent>).detail);
    };
    document.addEventListener(IDPN_MFE_EVENT_NAME, listener);

    window.history.replaceState(
      {},
      '',
      '/?client_id=app-a&ui_locales=fa-IR&login_request=request-123&return_to=%2Foauth2%2Fauthorize%3Fclient_id%3Dapp-a',
    );

    render(
      <HostedLoginPage
        search={window.location.search}
        fetchConfig={vi.fn().mockResolvedValue(CONFIG)}
        fetchBundle={fetchBundle}
      />,
    );
    await waitForForm();

    const identifier = screen.getByLabelText('ایمیل یا نام کاربری');
    await user.type(identifier, 'sara@example.com');

    await user.click(screen.getByRole('combobox', { name: 'زبان' }));
    await user.click(await screen.findByRole('option', { name: 'English' }));

    expect(
      await screen.findByRole('heading', { name: 'Customer portal sign-in' }),
    ).toBeInTheDocument();
    const root = screen.getByTestId('idpn-root');
    expect(root).toHaveAttribute('lang', 'en-US');
    expect(root).toHaveAttribute('dir', 'ltr');
    expect(root.style.getPropertyValue('--idpn-font-sans')).toContain("'Inter'");
    // The in-progress input is preserved across the locale change.
    expect(screen.getByLabelText('Email or username')).toHaveValue('sara@example.com');

    const params = new URLSearchParams(window.location.search);
    expect(params.get('ui_locales')).toBe('en-US');
    expect(params.get('return_to')).toBe('/oauth2/authorize?client_id=app-a');
    expect(params.get('login_request')).toBe('request-123');
    expect(window.location.pathname).toBe('/');

    expect(events).toContainEqual({ type: 'locale:changed', locale: 'en-US', dir: 'ltr' });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    document.removeEventListener(IDPN_MFE_EVENT_NAME, listener);
  });
});
