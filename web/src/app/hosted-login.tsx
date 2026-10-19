import * as React from 'react';

import { IdpnRoot } from '@/app/idpn-root';
import { LoginForm, type LoginFormValues } from '@/app/login-form';
import { MfaForm, type MfaErrorCode, type MfaFormValues } from '@/app/mfa-form';
import {
  SocialLogin,
  selectSocialProviders,
  socialErrorMessageKey,
  type SocialProviderSummary,
} from '@/app/social-login';
import { directionOf, resolveLocale, type Locale } from '@/i18n';

interface PublicConfigLike {
  locale?: string;
  locales?: { default?: string; supported?: string[] };
  theme?: Record<string, string>;
  loginContexts?: { key: string; methods: string[] }[];
  socialProviders?: SocialProviderSummary[];
}

/** Outcome of the password step (`POST /api/v1/login`). */
export type LoginSubmitResult =
  | { ok: true; redirectTo?: string }
  | { ok: false; reason: 'invalid_credentials' | 'network' }
  | { ok: false; reason: 'mfa_required'; challengeToken: string }
  | { ok: false; reason: 'mfa_enrollment_required' };

export interface MfaVerifyInput extends MfaFormValues {
  challengeToken: string;
}

export type MfaVerifyResult =
  { ok: true; redirectTo?: string } | { ok: false; reason: MfaErrorCode };

export interface HostedLoginPageProps {
  /** Reads the query string; injectable for tests. */
  search?: string;
  fetchConfig?: (clientId: string) => Promise<PublicConfigLike | null>;
  submit?: (
    values: LoginFormValues & { clientId?: string; loginContext?: string; returnTo?: string },
  ) => Promise<LoginSubmitResult>;
  /** Second-factor call (`POST /api/v1/login/mfa/verify`); injectable for tests. */
  verify?: (values: MfaVerifyInput) => Promise<MfaVerifyResult>;
  /** Called with a safe redirect target; defaults to `window.location.assign`. */
  navigate?: (target: string) => void;
}

const DEFAULT_THEME: Record<string, string> = {};

/** RFC 5321 caps a forward path at 256 octets; keep room for the `@domain` part. */
const MAX_LOGIN_HINT_LENGTH = 254;

/**
 * `login_hint` is untrusted input from the authorize URL: it only prefills the identifier
 * field and is never sent anywhere before the user submits the form.
 */
export function normalizeLoginHint(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, MAX_LOGIN_HINT_LENGTH);
}

async function defaultFetchConfig(clientId: string): Promise<PublicConfigLike | null> {
  const response = await fetch(`/api/v1/clients/${encodeURIComponent(clientId)}/public-config`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as PublicConfigLike;
}

async function defaultSubmit(
  values: LoginFormValues & { clientId?: string; loginContext?: string; returnTo?: string },
): Promise<LoginSubmitResult> {
  let response: Response;
  try {
    response = await fetch('/api/v1/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(values),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }

  if (response.status === 401) {
    return { ok: false, reason: 'invalid_credentials' };
  }
  if (response.status === 403) {
    const problem = (await response.json().catch((): unknown => null)) as {
      error?: unknown;
    } | null;
    if (problem?.error === 'mfa_enrollment_required') {
      return { ok: false, reason: 'mfa_enrollment_required' };
    }
    return { ok: false, reason: 'network' };
  }
  if (!response.ok) {
    return { ok: false, reason: 'network' };
  }

  const payload = (await response.json()) as {
    mfa?: unknown;
    challengeToken?: unknown;
    redirectTo?: unknown;
  };
  if (payload.mfa === 'challenge' && typeof payload.challengeToken === 'string') {
    return { ok: false, reason: 'mfa_required', challengeToken: payload.challengeToken };
  }
  return typeof payload.redirectTo === 'string'
    ? { ok: true, redirectTo: payload.redirectTo }
    : { ok: true };
}

async function defaultVerify(values: MfaVerifyInput): Promise<MfaVerifyResult> {
  let response: Response;
  try {
    response = await fetch('/api/v1/login/mfa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(values),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }

  if (response.status === 429) {
    return { ok: false, reason: 'rate_limited' };
  }
  if (response.status === 400) {
    return { ok: false, reason: 'invalid_code' };
  }
  if (response.status === 401) {
    const problem = (await response.json().catch((): unknown => null)) as {
      error?: unknown;
    } | null;
    // An unknown/expired challenge is not a wrong code: the user must start over.
    return problem?.error === 'mfa_challenge_invalid'
      ? { ok: false, reason: 'expired' }
      : { ok: false, reason: 'invalid_code' };
  }
  if (!response.ok) {
    return { ok: false, reason: 'network' };
  }

  const payload = (await response.json()) as { redirectTo?: unknown };
  return typeof payload.redirectTo === 'string'
    ? { ok: true, redirectTo: payload.redirectTo }
    : { ok: true };
}

/**
 * Hosted Auth UI page: reads `client_id`, `return_to`, `ui_locales` and `login_hint`, applies
 * the client theme and renders the localized login form. No token ever reaches this page —
 * only the HttpOnly `idpn_session` cookie set by the API on success.
 */
export function HostedLoginPage({
  search,
  fetchConfig = defaultFetchConfig,
  submit = defaultSubmit,
  verify = defaultVerify,
  navigate,
}: HostedLoginPageProps) {
  const params = React.useMemo(
    () =>
      new URLSearchParams(search ?? (typeof window === 'undefined' ? '' : window.location.search)),
    [search],
  );
  const clientId = params.get('client_id') ?? undefined;
  const returnTo = params.get('return_to') ?? params.get('redirect_uri') ?? undefined;
  const uiLocales = params.get('ui_locales') ?? undefined;
  const loginHint = normalizeLoginHint(params.get('login_hint'));
  /** Opaque handle from `/oauth2/authorize`; required by the social start endpoint. */
  const loginRequest = params.get('login_request') ?? undefined;
  const loginContext = params.get('login_context') ?? undefined;
  /** Social callback failures arrive as an `error` query value (docs/auth-flows.md 9.5). */
  const socialError = params.get('error');

  const [config, setConfig] = React.useState<PublicConfigLike | null>(null);
  const [locale, setLocale] = React.useState<Locale>(() => resolveLocale(uiLocales));
  const [theme, setTheme] = React.useState<Record<string, string>>(DEFAULT_THEME);
  const [submitting, setSubmitting] = React.useState(false);
  const [errorCode, setErrorCode] = React.useState<
    'invalid_credentials' | 'network' | 'mfa_enrollment_required' | null
  >(null);
  /** Set once the password step returned an MFA challenge (single-use token). */
  const [challengeToken, setChallengeToken] = React.useState<string | null>(null);
  const [mfaSubmitting, setMfaSubmitting] = React.useState(false);
  const [mfaError, setMfaError] = React.useState<MfaErrorCode | null>(null);

  React.useEffect(() => {
    if (clientId === undefined) {
      return;
    }
    let cancelled = false;
    void fetchConfig(clientId)
      .then((loaded) => {
        if (cancelled || loaded === null) {
          return;
        }
        setConfig(loaded);
        setLocale(
          resolveLocale(uiLocales, loaded.locales?.supported ?? ['fa-IR'], loaded.locales?.default),
        );
        setTheme(loaded.theme ?? {});
      })
      .catch(() => {
        // A missing public config must not block login; defaults are used.
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, fetchConfig, uiLocales]);

  const dir = directionOf(locale);

  const socialProviders = selectSocialProviders(
    config?.socialProviders,
    config?.loginContexts,
    loginContext,
  );
  const socialErrorKey = socialErrorMessageKey(socialError);
  const showSocial = socialProviders.length > 0 || socialErrorKey !== null;

  const navigateTo = (target: string): void => {
    if (navigate !== undefined) {
      navigate(target);
    } else if (typeof window !== 'undefined') {
      window.location.assign(target);
    }
  };

  const handleSubmit = async (values: LoginFormValues) => {
    setSubmitting(true);
    setErrorCode(null);
    try {
      const result = await submit({
        ...values,
        ...(clientId === undefined ? {} : { clientId }),
        ...(loginContext === undefined ? {} : { loginContext }),
        ...(returnTo === undefined ? {} : { returnTo }),
      });
      if (!result.ok) {
        if (result.reason === 'mfa_required') {
          // No session and no cookie yet: the second factor completes the login.
          setMfaError(null);
          setChallengeToken(result.challengeToken);
          return;
        }
        setErrorCode(result.reason);
        return;
      }
      navigateTo(result.redirectTo ?? returnTo ?? '/');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async (values: MfaFormValues) => {
    if (challengeToken === null) {
      return;
    }
    setMfaSubmitting(true);
    setMfaError(null);
    try {
      const result = await verify({ ...values, challengeToken });
      if (!result.ok) {
        setMfaError(result.reason);
        return;
      }
      navigateTo(result.redirectTo ?? returnTo ?? '/');
    } finally {
      setMfaSubmitting(false);
    }
  };

  const backToPassword = (): void => {
    // The challenge stays valid server-side until its TTL, but the browser drops the token.
    setChallengeToken(null);
    setMfaError(null);
  };

  return (
    <IdpnRoot
      locale={locale}
      dir={dir}
      theme={theme}
      data-client-id={clientId}
      aria-busy={submitting || mfaSubmitting}
    >
      {challengeToken === null ? (
        <LoginForm
          locale={locale}
          dir={dir}
          submitting={submitting}
          errorCode={errorCode}
          defaultIdentifier={loginHint}
          social={
            showSocial ? (
              <SocialLogin
                locale={locale}
                clientId={clientId ?? ''}
                providers={socialProviders}
                loginRequest={loginRequest}
                returnTo={returnTo}
                loginHint={loginHint}
                errorCode={socialError}
                navigate={navigate}
              />
            ) : undefined
          }
          onSubmit={handleSubmit}
        />
      ) : (
        <MfaForm
          locale={locale}
          dir={dir}
          submitting={mfaSubmitting}
          errorCode={mfaError}
          onBack={backToPassword}
          onSubmit={handleVerify}
        />
      )}
      {config === null ? null : <span hidden data-testid="public-config-loaded" />}
    </IdpnRoot>
  );
}
