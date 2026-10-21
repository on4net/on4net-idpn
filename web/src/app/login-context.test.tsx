import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComponentProps } from 'react';

import { IDPN_MFE_EVENT_NAME, type IdpnEvent } from '@idpn/mfe-sdk';

import { expectNoBlockingAxeViolations } from '@/test/axe';
import {
  resolveLoginContext,
  sanitizeLoginContexts,
  withLoginContext,
  type LoginContextSummary,
} from './login-context';
import { HostedLoginPage } from './hosted-login';

const ADMIN: LoginContextSummary = {
  key: 'customer-admin',
  name: 'ورود مدیر مشتری',
  description: 'مدیریت کاربران و صورت‌حساب',
  methods: ['password', 'google'],
  mfaPolicy: 'required_all',
  registrationPolicy: 'invite_only',
  branding: {
    title: 'پنل مدیر مشتری',
    logoUrl: 'https://app-a.example.com/admin.svg',
    theme: { primary: '#0f766e' },
  },
};

const TEAM: LoginContextSummary = {
  key: 'customer-team',
  name: 'ورود تیم مشتری',
  description: 'عملیات روزمره',
  methods: ['password', 'facebook'],
  mfaPolicy: 'optional',
  registrationPolicy: 'self_service',
};

const AUTHORIZE_PATH =
  '/oauth2/authorize?client_id=app-a&scope=openid%20profile&state=state-abc&nonce=nonce-1' +
  '&code_challenge=challenge-xyz&code_challenge_method=S256&login_hint=sara%40example.com';

const authorizeQuery = encodeURIComponent(AUTHORIZE_PATH);

const CONFIG = (loginContexts: unknown[], defaultLoginContext?: string) => ({
  locale: 'fa-IR',
  locales: {
    default: 'fa-IR',
    supported: ['fa-IR', 'en-US'],
    dir: { 'fa-IR': 'rtl' as const, 'en-US': 'ltr' as const },
  },
  theme: { primary: '#0057b8' },
  loginContexts,
  ...(defaultLoginContext === undefined ? {} : { defaultLoginContext }),
  socialProviders: [
    { provider: 'google', label: 'Google' },
    { provider: 'facebook', label: 'Facebook' },
  ],
});

async function renderHosted(element: React.ReactElement) {
  const result = render(element);
  await waitFor(() =>
    expect(screen.queryByTestId('hosted-login-skeleton')).not.toBeInTheDocument(),
  );
  return result;
}

/** Hosted page pinned to the shipped Persian bundle; tests never depend on the host locale. */
function Page(props: ComponentProps<typeof HostedLoginPage>) {
  return <HostedLoginPage acceptLanguage="fa-IR" {...props} />;
}

function captureEvents(): { events: IdpnEvent[]; stop: () => void } {
  const events: IdpnEvent[] = [];
  const listener = (event: Event): void => {
    events.push((event as CustomEvent<IdpnEvent>).detail);
  };
  document.addEventListener(IDPN_MFE_EVENT_NAME, listener);
  return { events, stop: () => document.removeEventListener(IDPN_MFE_EVENT_NAME, listener) };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('context method availability', () => {
  const SOCIAL_ONLY: LoginContextSummary = {
    key: 'customer-social',
    name: '???? ?? ?????',
    methods: ['google'],
    mfaPolicy: 'optional',
    registrationPolicy: 'disabled',
  };

  it('offers the allowed social provider when the context forbids passwords', async () => {
    // `loginMethods: ['google']` is a valid admin configuration; the page must not be a dead end.
    await renderHosted(
      <Page
        search="?client_id=app-a"
        fetchConfig={vi.fn().mockResolvedValue(CONFIG([SOCIAL_ONLY], SOCIAL_ONLY.key))}
      />,
    );

    expect(screen.queryByLabelText('??? ????')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Google/ })).toBeInTheDocument();
  });

  it('shows the unavailable notice for a single-context client that asked for another context', async () => {
    await renderHosted(
      <Page
        search="?client_id=app-a&login_context=retired"
        fetchConfig={vi.fn().mockResolvedValue(CONFIG([SOCIAL_ONLY], SOCIAL_ONLY.key))}
      />,
    );

    expect(screen.getByTestId('login-context-selector')).toBeInTheDocument();
    // The documented "not available" notice, not a silent substitution.
    expect(
      within(screen.getByTestId('login-context-selector')).getByRole('status'),
    ).toBeInTheDocument();
  });
});
describe('sanitizeLoginContexts', () => {  it('keeps valid contexts in server order and drops malformed entries', () => {
    const contexts = sanitizeLoginContexts([
      {
        key: 'customer-admin',
        name: 'Admin',
        methods: ['password', 'google'],
        mfaPolicy: 'required_all',
      },
      { key: 'customer-admin', name: 'Duplicate', methods: ['password'], mfaPolicy: 'optional' },
      { key: '', name: 'No key', methods: ['password'], mfaPolicy: 'optional' },
      { key: 'no-methods', name: 'No methods', methods: [], mfaPolicy: 'optional' },
      { key: 'unknown-method', name: 'Unknown', methods: ['sms'], mfaPolicy: 'optional' },
      'not-an-object',
      null,
    ]);

    expect(contexts.map((context) => context.key)).toEqual(['customer-admin']);
    expect(contexts[0]?.methods).toEqual(['password', 'google']);
    expect(contexts[0]?.mfaPolicy).toBe('required_all');
  });

  it('falls back to the key as name and to the optional MFA policy', () => {
    const [context] = sanitizeLoginContexts([
      { key: 'support', methods: ['password', 'password'], mfaPolicy: 'unknown' },
    ]);

    expect(context).toMatchObject({
      key: 'support',
      name: 'support',
      methods: ['password'],
      mfaPolicy: 'optional',
    });
    expect(context?.branding).toBeUndefined();
    expect(context?.registrationPolicy).toBeUndefined();
  });

  it('drops hostile branding values instead of passing them to the DOM', () => {
    const [context] = sanitizeLoginContexts([
      {
        key: 'admin',
        name: 'Admin',
        methods: ['password'],
        mfaPolicy: 'optional',
        branding: {
          title: 'Admin portal',
          logoUrl: 'javascript:alert(1)',
          theme: { primary: 'url(javascript:alert(1))', background: '#0b0b0b', foreground: '#f8fafc', unknown: '#fff' },
          rawCss: 'body { display: none }',
        },
      },
    ]);

    expect(context?.branding?.logoUrl).toBeUndefined();
    expect(context?.branding?.title).toBe('Admin portal');
    expect(context?.branding?.theme).toEqual({ background: '#0b0b0b', foreground: '#f8fafc' });
    expect(JSON.stringify(context)).not.toMatch(/javascript|display|rawcss/i);
  });

  it('returns an empty list for a non-array payload', () => {
    expect(sanitizeLoginContexts(undefined)).toEqual([]);
    expect(sanitizeLoginContexts({ key: 'admin' })).toEqual([]);
  });
});

describe('resolveLoginContext', () => {
  it('does nothing for a client without contexts', () => {
    expect(resolveLoginContext({ contexts: [] })).toEqual({
      requiresSelection: false,
      invalidRequested: false,
    });
  });

  it('skips the selector for a single-context client', () => {
    const resolution = resolveLoginContext({ contexts: [ADMIN] });

    expect(resolution.context?.key).toBe(ADMIN.key);
    expect(resolution.requiresSelection).toBe(false);
  });

  it('preselects the default context when several contexts exist', () => {
    const resolution = resolveLoginContext({
      contexts: [ADMIN, TEAM],
      defaultKey: TEAM.key,
    });

    expect(resolution.context?.key).toBe(TEAM.key);
    expect(resolution.requiresSelection).toBe(true);
    expect(resolution.invalidRequested).toBe(false);
  });

  it('falls back to the first context without a default and lets a selection win', () => {
    expect(resolveLoginContext({ contexts: [ADMIN, TEAM] }).context?.key).toBe(ADMIN.key);
    expect(
      resolveLoginContext({ contexts: [ADMIN, TEAM], defaultKey: TEAM.key, selectedKey: ADMIN.key })
        .context?.key,
    ).toBe(ADMIN.key);
  });

  it('honours the context requested by the authorize redirect and hides the selector', () => {
    const resolution = resolveLoginContext({
      contexts: [ADMIN, TEAM],
      requestedKey: ADMIN.key,
      defaultKey: TEAM.key,
    });

    expect(resolution.context?.key).toBe(ADMIN.key);
    expect(resolution.requiresSelection).toBe(false);
  });

  it('never honours an unknown or disabled requested context', () => {
    const disabled = resolveLoginContext({
      contexts: [ADMIN, TEAM],
      requestedKey: 'customer-disabled',
      defaultKey: TEAM.key,
    });

    expect(disabled.context?.key).toBe(TEAM.key);
    expect(disabled.invalidRequested).toBe(true);
    expect(disabled.requiresSelection).toBe(true);

    const single = resolveLoginContext({ contexts: [ADMIN], requestedKey: 'customer-disabled' });
    expect(single.context?.key).toBe(ADMIN.key);
    expect(single.invalidRequested).toBe(true);
    expect(single.requiresSelection).toBe(false);
  });
});

describe('withLoginContext', () => {
  it('adds only login_context and preserves the whole authorize request', () => {
    const bound = withLoginContext(AUTHORIZE_PATH, ADMIN.key);
    const url = new URL(String(bound), 'http://idp.test');

    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('login_context')).toBe(ADMIN.key);
    for (const [name, value] of new URLSearchParams(AUTHORIZE_PATH.split('?')[1]).entries()) {
      expect(url.searchParams.get(name), name).toBe(value);
    }
    expect(String(bound)).not.toMatch(/token|secret|client_secret/i);
  });

  it('keeps an absolute authorize URL absolute and its hash intact', () => {
    const bound = String(
      withLoginContext('https://auth.example.com/oauth2/authorize?client_id=app-a#frag', TEAM.key),
    );
    const url = new URL(bound);

    expect(url.origin).toBe('https://auth.example.com');
    expect(url.searchParams.get('login_context')).toBe(TEAM.key);
    expect(url.hash).toBe('#frag');
  });

  it('leaves non-authorize targets and incomplete input untouched', () => {
    expect(withLoginContext('https://app-a.example.com/cb', ADMIN.key)).toBe(
      'https://app-a.example.com/cb',
    );
    expect(withLoginContext(undefined, ADMIN.key)).toBeUndefined();
    expect(withLoginContext(AUTHORIZE_PATH, undefined)).toBe(AUTHORIZE_PATH);
    expect(withLoginContext(AUTHORIZE_PATH, '  ')).toBe(AUTHORIZE_PATH);
    expect(withLoginContext('not a url', ADMIN.key)).toBe('not a url');
  });
});

describe('Hosted login context selection', () => {
  it('renders no selector or context panel for a client without contexts', async () => {
    await renderHosted(
      <Page
        acceptLanguage="fa-IR"
        search="?client_id=app-a"
        fetchConfig={vi.fn().mockResolvedValue(CONFIG([]))}
      />,
    );

    expect(screen.queryByTestId('login-context-selector')).not.toBeInTheDocument();
    expect(screen.queryByTestId('login-context-panel')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ورود به حساب' })).toBeInTheDocument();
  });

  it('skips the selector for a single context but applies its branding', async () => {
    await renderHosted(
      <Page
        search="?client_id=app-a"
        fetchConfig={vi.fn().mockResolvedValue(CONFIG([ADMIN], ADMIN.key))}
      />,
    );

    expect(screen.queryByTestId('login-context-selector')).not.toBeInTheDocument();
    expect(screen.getByTestId('login-context-panel')).toHaveTextContent('پنل مدیر مشتری');
    expect(screen.getByTestId('login-context-panel')).toHaveTextContent('مدیریت کاربران');
    expect(screen.getByTestId('login-context-panel')).toHaveTextContent(
      'برای این روش ورود، تأیید دومرحله‌ای الزامی است.',
    );
    expect(screen.getByTestId('login-context-panel')).toHaveTextContent(
      'ساخت حساب فقط با دعوت مدیر امکان‌پذیر است.',
    );
  });

  it('lists only the active contexts and preselects exactly the default one', async () => {
    const fetchConfig = vi.fn().mockResolvedValue(
      CONFIG(
        [
          ADMIN,
          TEAM,
          // A context that is filtered out client-side because it cannot be rendered.
          { key: 'broken', name: 'Broken', methods: [], mfaPolicy: 'optional' },
        ],
        TEAM.key,
      ),
    );

    await renderHosted(
      <Page acceptLanguage="fa-IR" search="?client_id=app-a" fetchConfig={fetchConfig} />,
    );

    const group = screen.getByRole('group', { name: 'انتخاب روش ورود' });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(screen.queryByText('Broken')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /ورود تیم مشتری/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /ورود مدیر مشتری/ })).not.toBeChecked();
    expect(screen.getByText('پیش‌فرض')).toBeInTheDocument();
    // The default context drives the theme, the branding and the provider list.
    expect(screen.getByTestId('login-context-panel')).toHaveAttribute(
      'data-login-context',
      TEAM.key,
    );
    expect(screen.getByTestId('idpn-root').style.getPropertyValue('--idpn-primary')).toBe(
      '#0057b8',
    );
    expect(screen.getByRole('button', { name: 'ادامه با Facebook' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ادامه با Google' })).not.toBeInTheDocument();
    await expectNoBlockingAxeViolations();
  });

  it('switches context without losing form state and binds the authorize request', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue({ ok: true });
    const { events, stop } = captureEvents();
    const fetchConfig = vi.fn().mockResolvedValue(CONFIG([ADMIN, TEAM], TEAM.key));

    window.history.replaceState(
      {},
      '',
      `/?client_id=app-a&return_to=${authorizeQuery}&login_request=request-123`,
    );

    await renderHosted(
      <Page
        search={window.location.search}
        fetchConfig={fetchConfig}
        submit={submit}
        navigate={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText('ایمیل یا نام کاربری'), 'sara@example.com');
    await user.click(screen.getByRole('radio', { name: /ورود مدیر مشتری/ }));

    expect(screen.getByRole('radio', { name: /ورود مدیر مشتری/ })).toBeChecked();
    expect(screen.getByLabelText('ایمیل یا نام کاربری')).toHaveValue('sara@example.com');
    expect(screen.getByTestId('login-context-panel')).toHaveTextContent('پنل مدیر مشتری');
    expect(screen.getByTestId('idpn-root').style.getPropertyValue('--idpn-primary')).toBe(
      '#0f766e',
    );
    expect(screen.getByRole('button', { name: 'ادامه با Google' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Facebook/ })).not.toBeInTheDocument();
    expect(events).toContainEqual({ type: 'context:changed', loginContext: ADMIN.key });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('login_context')).toBe(ADMIN.key);
    expect(params.get('login_request')).toBe('request-123');
    const returnTo = new URL(params.get('return_to') ?? '', 'http://idp.test');
    expect(returnTo.pathname).toBe('/oauth2/authorize');
    expect(returnTo.searchParams.get('login_context')).toBe(ADMIN.key);
    expect(returnTo.searchParams.get('state')).toBe('state-abc');
    expect(returnTo.searchParams.get('nonce')).toBe('nonce-1');
    expect(returnTo.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(returnTo.searchParams.get('code_challenge_method')).toBe('S256');
    expect(returnTo.searchParams.get('login_hint')).toBe('sara@example.com');
    expect(returnTo.searchParams.get('scope')).toBe('openid profile');
    expect(window.location.pathname).toBe('/');

    await user.type(screen.getByLabelText('رمز عبور'), 'a-very-long-password');
    await user.click(screen.getByRole('button', { name: 'ورود' }));

    expect(submit).toHaveBeenCalledTimes(1);
    const payload = submit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['loginContext']).toBe(ADMIN.key);
    expect(payload['identifier']).toBe('sara@example.com');
    expect(String(payload['returnTo'])).toContain(`login_context=${ADMIN.key}`);
    expect(JSON.stringify(payload)).not.toMatch(/access_token|refresh_token|client_secret/i);

    const storage = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(storage).toBe('{}');
    stop();
  });

  it('keeps the locale, direction and parameters while switching context', async () => {
    const user = userEvent.setup();
    const fetchConfig = vi.fn().mockResolvedValue({
      ...CONFIG([ADMIN, TEAM], TEAM.key),
      locale: 'en-US',
      locales: {
        default: 'en-US',
        supported: ['en-US', 'fa-IR'],
        dir: { 'en-US': 'ltr' as const, 'fa-IR': 'rtl' as const },
      },
    });

    window.history.replaceState({}, '', '/?client_id=app-a&ui_locales=en-US');

    await renderHosted(<Page search={window.location.search} fetchConfig={fetchConfig} />);

    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'ltr');
    await user.click(screen.getByRole('radio', { name: /ورود مدیر مشتری/ }));

    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('idpn-root')).toHaveAttribute('lang', 'en-US');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    const params = new URLSearchParams(window.location.search);
    expect(params.get('ui_locales')).toBe('en-US');
    expect(params.get('login_context')).toBe(ADMIN.key);
  });

  it('honours a deep-linked login_context and skips the selector', async () => {
    await renderHosted(
      <Page
        search="?client_id=app-a&login_context=customer-admin"
        fetchConfig={vi.fn().mockResolvedValue(CONFIG([ADMIN, TEAM], TEAM.key))}
      />,
    );

    expect(screen.queryByTestId('login-context-selector')).not.toBeInTheDocument();
    expect(screen.getByTestId('login-context-panel')).toHaveAttribute(
      'data-login-context',
      ADMIN.key,
    );
    expect(screen.getByRole('button', { name: 'ادامه با Google' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Facebook/ })).not.toBeInTheDocument();
  });

  it('replaces an unknown or disabled requested context instead of honouring it', async () => {
    await renderHosted(
      <Page
        search="?client_id=app-a&login_context=customer-disabled"
        fetchConfig={vi.fn().mockResolvedValue(CONFIG([ADMIN, TEAM], TEAM.key))}
      />,
    );

    expect(screen.getByText(/این روش ورود در دسترس نیست/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /ورود تیم مشتری/ })).toBeChecked();
    expect(screen.getByTestId('login-context-panel')).toHaveAttribute(
      'data-login-context',
      TEAM.key,
    );
    expect(document.body.textContent).not.toContain('customer-disabled');
  });

  it('hides the password form for a context that does not allow it', async () => {
    await renderHosted(
      <Page
        search="?client_id=app-a"
        fetchConfig={vi.fn().mockResolvedValue(CONFIG([{ ...ADMIN, methods: ['sso'] }], ADMIN.key))}
      />,
    );

    expect(screen.getByTestId('login-context-method-notice')).toHaveTextContent(
      'این روش ورود با رمز عبور انجام نمی‌شود',
    );
    expect(screen.queryByLabelText('رمز عبور')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ورود' })).not.toBeInTheDocument();
    await expectNoBlockingAxeViolations();
  });
});
