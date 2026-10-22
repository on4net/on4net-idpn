import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { IdpnRoot } from './idpn-root';
import {
  SocialLogin,
  buildSocialStartUrl,
  isSocialProviderId,
  selectSocialProviders,
  socialErrorMessageKey,
  type SocialProviderSummary,
} from './social-login';
import { translate } from '@/i18n';

const google: SocialProviderSummary = { provider: 'google', label: 'Google' };
const facebook: SocialProviderSummary = { provider: 'facebook', label: 'Facebook' };

function renderSocial(overrides: Partial<React.ComponentProps<typeof SocialLogin>> = {}) {
  const navigate = vi.fn();
  const view = render(
    <IdpnRoot locale="fa-IR" dir="rtl">
      <SocialLogin
        locale="fa-IR"
        clientId="app-a"
        providers={[google]}
        loginRequest="request-123"
        navigate={navigate}
        {...overrides}
      />
    </IdpnRoot>,
  );
  return { ...view, navigate };
}

describe('buildSocialStartUrl', () => {
  it('builds the per-client and per-provider start URL', () => {
    expect(buildSocialStartUrl({ clientId: 'app-a', provider: 'google' })).toBe(
      '/oauth2/social/app-a/google/start',
    );
  });

  it('preserves login_request, return_to and login_hint', () => {
    const url = buildSocialStartUrl({
      clientId: 'app-a',
      provider: 'facebook',
      loginRequest: 'opaque-request',
      returnTo: 'https://auth.example.com/oauth2/authorize?client_id=app-a&state=state-123',
      loginHint: 'sara@example.com',
    });

    expect(url.startsWith('/oauth2/social/app-a/facebook/start?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('login_request')).toBe('opaque-request');
    expect(params.get('return_to')).toBe(
      'https://auth.example.com/oauth2/authorize?client_id=app-a&state=state-123',
    );
    expect(params.get('login_hint')).toBe('sara@example.com');
  });

  it('encodes the client id and drops blank optional parameters', () => {
    const url = buildSocialStartUrl({
      clientId: 'app/a?b',
      provider: 'google',
      loginRequest: '   ',
      returnTo: '',
      loginHint: null,
    });

    expect(url).toBe('/oauth2/social/app%2Fa%3Fb/google/start');
  });

  it('caps a long login_hint so the URL stays bounded', () => {
    const url = buildSocialStartUrl({
      clientId: 'app-a',
      provider: 'google',
      loginHint: 'x'.repeat(400),
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('login_hint')).toHaveLength(254);
  });

  it('preserves a long return_to verbatim', () => {
    const returnTo = `https://auth.example.com/oauth2/authorize?${'state='.concat('s'.repeat(400))}`;
    const url = buildSocialStartUrl({ clientId: 'app-a', provider: 'google', returnTo });

    expect(new URLSearchParams(url.split('?')[1]).get('return_to')).toBe(returnTo);
  });
});

describe('selectSocialProviders', () => {
  it('keeps only contract providers and removes duplicates', () => {
    expect(
      selectSocialProviders(
        [google, { provider: 'github', label: 'GitHub' }, google, facebook],
        undefined,
        undefined,
      ),
    ).toEqual([google, facebook]);
  });

  it('hides providers a selected login context does not allow', () => {
    expect(
      selectSocialProviders(
        [google, facebook],
        [{ key: 'team', methods: ['password', 'google'] }],
        'team',
      ),
    ).toEqual([google]);
  });

  it('falls back to the client list for an unknown context', () => {
    expect(
      selectSocialProviders([google, facebook], [{ key: 'team', methods: ['password'] }], 'other'),
    ).toEqual([google, facebook]);
  });

  it('returns an empty list when the public config has no providers', () => {
    expect(selectSocialProviders(undefined, undefined, undefined)).toEqual([]);
  });
});

describe('socialErrorMessageKey', () => {
  it('maps the documented social codes to translation keys', () => {
    expect(socialErrorMessageKey('social_state_invalid')).toBe('login.social.errorState');
    expect(socialErrorMessageKey('social_membership_suspended')).toBe(
      'login.social.errorMembershipSuspended',
    );
    expect(socialErrorMessageKey('social_account_conflict')).toBe(
      'login.social.errorAccountConflict',
    );
  });

  it('ignores unknown or unrelated error codes', () => {
    expect(socialErrorMessageKey('invalid_credentials')).toBeNull();
    expect(socialErrorMessageKey('<script>alert(1)</script>')).toBeNull();
    expect(socialErrorMessageKey(null)).toBeNull();
    expect(socialErrorMessageKey(undefined)).toBeNull();
  });
});

describe('isSocialProviderId', () => {
  it('accepts only the contract providers', () => {
    expect(isSocialProviderId('google')).toBe(true);
    expect(isSocialProviderId('facebook')).toBe(true);
    expect(isSocialProviderId('github')).toBe(false);
  });
});

describe('SocialLogin', () => {
  it('renders nothing when the client has no enabled providers and there is no error', () => {
    const { container } = render(
      <SocialLogin locale="fa-IR" clientId="app-a" providers={[]} loginRequest="request-123" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders exactly one button for one provider', () => {
    renderSocial({ providers: [google] });

    expect(screen.getByRole('heading', { name: 'ورود با سرویس‌های دیگر' })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'ادامه با Google' })).toBeEnabled();
    expect(screen.getByText('یا')).toBeInTheDocument();
  });

  it('renders one button per enabled provider', () => {
    renderSocial({ providers: [google, facebook] });

    expect(screen.getByRole('button', { name: 'ادامه با Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ادامه با Facebook' })).toBeInTheDocument();
  });

  it('navigates to the start endpoint and shows a disabled loading state', async () => {
    const user = userEvent.setup();
    const { navigate } = renderSocial({
      providers: [google, facebook],
      returnTo: '/oauth2/authorize?client_id=app-a',
      loginHint: 'sara@example.com',
    });

    await user.click(screen.getByRole('button', { name: 'ادامه با Google' }));

    expect(navigate).toHaveBeenCalledTimes(1);
    const target = String(navigate.mock.calls[0]?.[0]);
    const params = new URLSearchParams(target.split('?')[1]);
    expect(target.startsWith('/oauth2/social/app-a/google/start?')).toBe(true);
    expect(params.get('login_request')).toBe('request-123');
    expect(params.get('return_to')).toBe('/oauth2/authorize?client_id=app-a');
    expect(params.get('login_hint')).toBe('sara@example.com');

    const pending = screen.getByRole('button', { name: /در حال انتقال/ });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'ادامه با Facebook' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('در حال انتقال به Google…');
  });

  it('disables the buttons and explains why when no login_request is present', () => {
    renderSocial({ loginRequest: undefined });

    const button = screen.getByRole('button', { name: 'ادامه با Google' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-describedby');
    const note = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(note).toHaveTextContent('برای ورود با سرویس‌های خارجی، از صفحه اپ شروع کنید.');
  });

  it('shows a translated safe message for a callback error', () => {
    renderSocial({ errorCode: 'social_membership_suspended' });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('ورود انجام نشد');
    expect(alert).toHaveTextContent('دسترسی شما به این اپ غیرفعال شده است.');
    expect(screen.queryByText('social_membership_suspended')).not.toBeInTheDocument();
  });

  it('shows the callback error even when no provider is left for this client', () => {
    renderSocial({ providers: [], errorCode: 'social_provider_disabled' });

    expect(screen.getByRole('alert')).toHaveTextContent('این روش ورود در حال حاضر در دسترس نیست.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not render an alert for an unknown error value', () => {
    renderSocial({ errorCode: '<script>alert(1)</script>' });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders LTR English labels', () => {
    render(
      <IdpnRoot locale="en-US" dir="ltr">
        <SocialLogin
          locale="en-US"
          clientId="app-a"
          providers={[google, facebook]}
          loginRequest="request-123"
        />
      </IdpnRoot>,
    );

    expect(screen.getByTestId('idpn-root')).toHaveAttribute('dir', 'ltr');
    expect(
      screen.getByRole('heading', { name: 'Sign in with another service' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(translate('en-US', 'login.social.google')).toBe('Google');
    expect(translate('fa-IR', 'login.social.facebook')).toBe('Facebook');
  });

  it('labels the provider group with a heading for screen readers', () => {
    renderSocial({ providers: [google] });

    const section = screen.getByRole('region', { name: 'ورود با سرویس‌های دیگر' });
    expect(section).toBeInTheDocument();
  });
});
