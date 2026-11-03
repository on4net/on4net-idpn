import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  ConsentPage,
  defaultDecideConsent,
  defaultLoadConsent,
  safeConsentTarget,
  type ConsentDecisionResult,
  type ConsentLoadResult,
} from './consent-page';
import { HostedLoginPage } from './hosted-login';
import { IdpnRoot } from './idpn-root';

const details = {
  client: { clientId: 'partner-app', name: 'Partner Portal' },
  scopes: ['openid', 'profile', 'email', 'offline_access', 'custom.scope'],
};

function renderConsent(
  overrides: {
    locale?: 'fa-IR' | 'en-US';
    consentRequest?: string | undefined;
    load?: (id: string) => Promise<ConsentLoadResult>;
    decide?: (id: string, decision: 'allow' | 'deny') => Promise<ConsentDecisionResult>;
  } = {},
) {
  const onRedirect = vi.fn();
  const load = overrides.load ?? vi.fn().mockResolvedValue({ ok: true, details });
  const decide =
    overrides.decide ??
    vi
      .fn()
      .mockResolvedValue({ ok: true, redirectTo: 'https://auth.example.com/oauth2/authorize?x=1' });
  const locale = overrides.locale ?? 'en-US';
  const view = render(
    <IdpnRoot locale={locale} dir={locale === 'fa-IR' ? 'rtl' : 'ltr'}>
      <ConsentPage
        locale={locale}
        consentRequest={'consentRequest' in overrides ? overrides.consentRequest : 'handle-1'}
        load={load}
        decide={decide}
        onRedirect={onRedirect}
      />
    </IdpnRoot>,
  );
  return { ...view, onRedirect, load, decide };
}

describe('ConsentPage', () => {
  it('names the app, lists what is asked in plain language and focuses the question', async () => {
    renderConsent();

    const heading = await screen.findByRole('heading', {
      level: 1,
      name: 'Partner Portal wants access to your account',
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole('heading', { level: 2, name: 'Permissions' })).toBeInTheDocument();
    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual([
      'Confirm who you are',
      'See your name and profile',
      'See your email address',
      'Stay signed in without asking you again',
      'Access: custom.scope',
    ]);
  });

  it('never renders an unknown scope as anything but a plain token', async () => {
    renderConsent({
      load: vi.fn().mockResolvedValue({
        ok: true,
        details: { ...details, scopes: ['<img src=x onerror=alert(1)>'] },
      }),
    });

    expect(await screen.findByText('Access: …')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('allow sends the decision once and follows the validated target', async () => {
    const user = userEvent.setup();
    const { decide, onRedirect } = renderConsent();

    await user.click(await screen.findByRole('button', { name: 'Allow' }));

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith('handle-1', 'allow');
    await waitFor(() =>
      expect(onRedirect).toHaveBeenCalledWith('https://auth.example.com/oauth2/authorize?x=1'),
    );
  });

  it('deny sends deny and disables both buttons while the answer is in flight', async () => {
    const user = userEvent.setup();
    let release: (value: ConsentDecisionResult) => void = () => undefined;
    const decide = vi.fn().mockReturnValue(
      new Promise<ConsentDecisionResult>((resolve) => {
        release = resolve;
      }),
    );
    const { onRedirect } = renderConsent({ decide });

    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
    expect(screen.getByText('Saving your choice…')).toBeInTheDocument();

    release({ ok: true, redirectTo: 'https://partner.example.com/cb?error=access_denied' });
    await waitFor(() => expect(onRedirect).toHaveBeenCalledTimes(1));
    expect(decide).toHaveBeenCalledWith('handle-1', 'deny');
  });

  it('refuses to navigate to anything but an absolute http(s) URL', async () => {
    const user = userEvent.setup();
    for (const redirectTo of ['javascript:alert(1)', 'data:text/html,x', '/relative', null]) {
      const { onRedirect, unmount } = renderConsent({
        decide: vi.fn().mockResolvedValue({ ok: true, redirectTo }),
      });
      await user.click(await screen.findByRole('button', { name: 'Allow' }));
      expect(await screen.findByTestId('consent-error')).toBeVisible();
      expect(onRedirect).not.toHaveBeenCalled();
      unmount();
    }
    expect(safeConsentTarget('https://a.example/x?y=1')).toBe('https://a.example/x?y=1');
    expect(safeConsentTarget('ftp://a.example')).toBeNull();
  });

  it.each([
    ['login', 'Your session has ended. Sign in again to continue.'],
    [
      'not_found',
      'This request has expired or was already answered. Go back to the app and try again.',
    ],
    ['network', 'The connection failed. Check your network and try again.'],
  ] as const)('shows a distinct message when loading fails with %s', async (error, message) => {
    renderConsent({ load: vi.fn().mockResolvedValue({ ok: false, error }) });

    expect(await screen.findByTestId('consent-error')).toHaveTextContent(message);
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });

  it('shows the expired state without calling the API when there is no handle', async () => {
    const { load } = renderConsent({ consentRequest: undefined });

    expect(await screen.findByTestId('consent-error')).toBeVisible();
    expect(load).not.toHaveBeenCalled();
  });

  it('loads exactly once even when React mounts the effect twice', async () => {
    const load = vi.fn().mockResolvedValue({ ok: true, details });
    renderConsent({ load });
    await screen.findByRole('button', { name: 'Allow' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('renders in Persian with the right-to-left direction', async () => {
    renderConsent({ locale: 'fa-IR' });

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Partner Portal درخواست دسترسی به حساب شما را دارد',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'اجازه دادن' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'انصراف' })).toBeInTheDocument();
    expect(screen.getByText('دیدن نشانی ایمیل شما')).toBeInTheDocument();
    expect(document.querySelector('[dir="rtl"]')).not.toBeNull();
  });
});

describe('Hosted UI routing', () => {
  it('shows the consent screen for action=consent and hands the handle to the API call', async () => {
    const loadConsent = vi.fn().mockResolvedValue({ ok: true, details });
    render(
      <HostedLoginPage
        search="?action=consent&consent_request=abc123&client_id=partner-app&ui_locales=en-US"
        fetchConfig={vi.fn().mockResolvedValue(null)}
        loadConsent={loadConsent}
      />,
    );

    expect(
      await screen.findByRole('heading', { name: 'Partner Portal wants access to your account' }),
    ).toBeInTheDocument();
    expect(loadConsent).toHaveBeenCalledWith('abc123');
  });
});

describe('default API bindings', () => {
  const stubFetch = (status: number, body: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('reads the request with the session cookie and no token', async () => {
    const fetchMock = stubFetch(200, details);

    await expect(defaultLoadConsent('a/b')).resolves.toEqual({ ok: true, details });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/consent/requests/a%2Fb');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.stringify(init.headers)).not.toContain('Authorization');
    vi.unstubAllGlobals();
  });

  it('maps 401 to login, 404 to not found, 5xx to network and a malformed body to not found', async () => {
    for (const [status, expected] of [
      [401, 'login'],
      [404, 'not_found'],
      [503, 'network'],
    ] as const) {
      stubFetch(status, {});
      await expect(defaultLoadConsent('x')).resolves.toEqual({ ok: false, error: expected });
    }
    stubFetch(200, { client: 'nope' });
    await expect(defaultLoadConsent('x')).resolves.toEqual({ ok: false, error: 'not_found' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(defaultLoadConsent('x')).resolves.toEqual({ ok: false, error: 'network' });
    vi.unstubAllGlobals();
  });

  it('posts the decision as JSON and returns only the redirect the server chose', async () => {
    const fetchMock = stubFetch(200, { redirectTo: 'https://partner.example.com/cb' });

    await expect(defaultDecideConsent('h', 'deny')).resolves.toEqual({
      ok: true,
      redirectTo: 'https://partner.example.com/cb',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/consent/requests/h/decision');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ decision: 'deny' }));
    vi.unstubAllGlobals();
  });
});
