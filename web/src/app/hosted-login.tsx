import * as React from 'react';

import { IdpnRoot } from '@/app/idpn-root';
import { LoginForm, type LoginFormValues } from '@/app/login-form';
import { directionOf, resolveLocale, type Locale } from '@/i18n';

interface PublicConfigLike {
  locale?: string;
  locales?: { default?: string; supported?: string[] };
  theme?: Record<string, string>;
  loginContexts?: { key: string; methods: string[] }[];
}

export interface HostedLoginPageProps {
  /** Reads the query string; injectable for tests. */
  search?: string;
  fetchConfig?: (clientId: string) => Promise<PublicConfigLike | null>;
  submit?: (
    values: LoginFormValues & { clientId?: string; returnTo?: string },
  ) => Promise<
    { ok: true; redirectTo?: string } | { ok: false; reason: 'invalid_credentials' | 'network' }
  >;
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
  values: LoginFormValues & { clientId?: string; returnTo?: string },
): Promise<
  { ok: true; redirectTo?: string } | { ok: false; reason: 'invalid_credentials' | 'network' }
> {
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
  if (!response.ok) {
    return { ok: false, reason: 'network' };
  }

  const payload = (await response.json()) as { redirectTo?: string };
  return payload.redirectTo === undefined
    ? { ok: true }
    : { ok: true, redirectTo: payload.redirectTo };
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

  const [config, setConfig] = React.useState<PublicConfigLike | null>(null);
  const [locale, setLocale] = React.useState<Locale>(() => resolveLocale(uiLocales));
  const [theme, setTheme] = React.useState<Record<string, string>>(DEFAULT_THEME);
  const [submitting, setSubmitting] = React.useState(false);
  const [errorCode, setErrorCode] = React.useState<'invalid_credentials' | 'network' | null>(null);

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

  const handleSubmit = async (values: LoginFormValues) => {
    setSubmitting(true);
    setErrorCode(null);
    try {
      const result = await submit({
        ...values,
        ...(clientId === undefined ? {} : { clientId }),
        ...(returnTo === undefined ? {} : { returnTo }),
      });
      if (!result.ok) {
        setErrorCode(result.reason);
        return;
      }
      const target = result.redirectTo ?? returnTo ?? '/';
      if (navigate !== undefined) {
        navigate(target);
      } else if (typeof window !== 'undefined') {
        window.location.assign(target);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <IdpnRoot
      locale={locale}
      dir={dir}
      theme={theme}
      data-client-id={clientId}
      aria-busy={submitting}
    >
      <LoginForm
        locale={locale}
        dir={dir}
        submitting={submitting}
        errorCode={errorCode}
        defaultIdentifier={loginHint}
        onSubmit={handleSubmit}
      />
      {config === null ? null : <span hidden data-testid="public-config-loaded" />}
    </IdpnRoot>
  );
}
