import * as React from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { translate, type Locale } from '@/i18n';

/**
 * Per-app social login buttons on the Hosted login page (`docs/auth-flows.md` 9).
 *
 * The provider list comes from the client's public config, which only contains providers the
 * API has enabled for that client. The start endpoint is server-authoritative: it consumes the
 * single-use `login_request` issued by `/oauth2/authorize`, so hiding a button is presentation
 * only and never a control (`docs/login-contexts.md` 9).
 */

export const SOCIAL_PROVIDER_IDS = ['google', 'facebook'] as const;

export type SocialProviderId = (typeof SOCIAL_PROVIDER_IDS)[number];

export interface SocialProviderSummary {
  provider: string;
  label?: string;
}

export interface SocialContextSummary {
  key: string;
  methods: readonly string[];
}

export function isSocialProviderId(value: string): value is SocialProviderId {
  return (SOCIAL_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Keeps only contract providers, de-duplicates, and — when the login page knows the selected
 * context — hides providers that context's `login_methods` does not allow. An unknown context
 * (stale public config) falls back to the client-wide list instead of hiding everything.
 */
export function selectSocialProviders(
  providers: readonly SocialProviderSummary[] | undefined,
  contexts: readonly SocialContextSummary[] | undefined,
  loginContext: string | undefined,
): SocialProviderSummary[] {
  const selected: SocialProviderSummary[] = [];
  const seen = new Set<string>();
  for (const entry of providers ?? []) {
    if (!isSocialProviderId(entry.provider) || seen.has(entry.provider)) {
      continue;
    }
    seen.add(entry.provider);
    selected.push({
      provider: entry.provider,
      ...(entry.label === undefined ? {} : { label: entry.label }),
    });
  }

  if (loginContext === undefined || loginContext === '') {
    return selected;
  }
  const context = (contexts ?? []).find((candidate) => candidate.key === loginContext);
  if (context === undefined) {
    return selected;
  }
  const allowed = new Set(context.methods);
  return selected.filter((entry) => allowed.has(entry.provider));
}

/** Query parameters the social start endpoint understands (the rest is bound server-side). */
export interface SocialStartUrlInput {
  clientId: string;
  provider: SocialProviderId;
  loginRequest?: string | null;
  /** Current `/oauth2/authorize` URL; the server never trusts it, but it is preserved. */
  returnTo?: string | null;
  loginHint?: string | null;
}

const MAX_LOGIN_HINT_LENGTH = 254;

/**
 * Builds `/oauth2/social/{clientId}/{provider}/start` (`docs/api.md` 2.8).
 *
 * `login_request` is the opaque handle issued by `/oauth2/authorize`; it is what makes the
 * request startable. `return_to` and `login_hint` are carried along, but no secret, scope or
 * provider credential ever appears in a URL built here.
 */
export function buildSocialStartUrl(input: SocialStartUrlInput): string {
  const path = `/oauth2/social/${encodeURIComponent(input.clientId)}/${input.provider}/start`;
  const params = new URLSearchParams();
  append(params, 'login_request', input.loginRequest);
  append(params, 'return_to', input.returnTo);
  // Only the hint is capped: it is the one value the login page itself normalizes.
  append(params, 'login_hint', input.loginHint, MAX_LOGIN_HINT_LENGTH);
  const query = params.toString();
  return query === '' ? path : `${path}?${query}`;
}

function append(
  params: URLSearchParams,
  name: string,
  value: string | null | undefined,
  maxLength?: number,
): void {
  if (value === null || value === undefined) {
    return;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return;
  }
  params.set(name, maxLength === undefined ? trimmed : trimmed.slice(0, maxLength));
}

/**
 * Allowlisted `social_*` codes (`docs/auth-flows.md` 9.5) mapped to translation keys. The raw
 * code is never rendered, so an unknown or attacker-supplied value cannot reach the page.
 */
const SOCIAL_ERROR_KEYS: Record<string, string> = {
  access_denied: 'login.social.errorAccessDenied',
  social_provider_disabled: 'login.social.errorProviderDisabled',
  social_state_invalid: 'login.social.errorState',
  social_email_unverified: 'login.social.errorEmailUnverified',
  social_account_conflict: 'login.social.errorAccountConflict',
  social_provider_error: 'login.social.errorProvider',
  social_membership_suspended: 'login.social.errorMembershipSuspended',
};

/** Returns the message key for a known social error, otherwise `null` (render nothing). */
export function socialErrorMessageKey(code: string | null | undefined): string | null {
  if (code === null || code === undefined || code === '') {
    return null;
  }
  return SOCIAL_ERROR_KEYS[code] ?? null;
}

export interface SocialLoginProps {
  locale: Locale;
  clientId: string;
  providers: readonly SocialProviderSummary[];
  /** Server-issued handle; without it the start endpoint cannot run. */
  loginRequest?: string;
  returnTo?: string;
  loginHint?: string;
  /** Raw `error` query value; only allowlisted social codes produce a message. */
  errorCode?: string | null;
  /** Injectable navigation for tests; defaults to `window.location.assign`. */
  navigate?: (target: string) => void;
}

export function SocialLogin({
  locale,
  clientId,
  providers,
  loginRequest,
  returnTo,
  loginHint,
  errorCode,
  navigate,
}: SocialLoginProps) {
  const headingId = React.useId();
  const noteId = React.useId();
  const [pending, setPending] = React.useState<SocialProviderId | null>(null);
  const t = (key: string, values: Record<string, string | number> = {}): string =>
    translate(locale, key, values);

  const errorKey = socialErrorMessageKey(errorCode);
  const errorAlert =
    errorKey === null ? null : (
      <Alert variant="destructive">
        <AlertTitle>{t('login.social.errorTitle')}</AlertTitle>
        <AlertDescription>{t(errorKey)}</AlertDescription>
      </Alert>
    );

  const available = selectSocialProviders(providers, undefined, undefined);
  if (available.length === 0) {
    return errorAlert;
  }

  const startable = loginRequest !== undefined && loginRequest.trim() !== '';
  const busy = pending !== null;

  const start = (provider: SocialProviderId): void => {
    if (busy || !startable) {
      return;
    }
    setPending(provider);
    const target = buildSocialStartUrl({
      clientId,
      provider,
      loginRequest,
      returnTo,
      loginHint,
    });
    if (navigate !== undefined) {
      navigate(target);
    } else if (typeof window !== 'undefined') {
      window.location.assign(target);
    }
  };

  return (
    <section aria-labelledby={headingId} aria-busy={busy ? true : undefined} className="grid gap-3">
      {errorAlert}
      <h2 id={headingId} className="text-sm font-medium text-foreground">
        {t('login.social.title')}
      </h2>
      <div className="grid gap-2">
        {available.map((entry) => {
          const provider = entry.provider as SocialProviderId;
          const name = t(`login.social.${provider}`);
          const isPending = pending === provider;
          const label = isPending
            ? t('login.social.redirecting', { provider: name })
            : t('login.social.continueWith', { provider: name });
          return (
            <Button
              key={provider}
              type="button"
              variant="outline"
              className="w-full justify-center gap-2"
              disabled={busy || !startable}
              aria-busy={isPending ? true : undefined}
              aria-describedby={startable ? undefined : noteId}
              onClick={() => start(provider)}
            >
              {isPending ? (
                <span aria-hidden="true">
                  <Spinner label="" />
                </span>
              ) : null}
              <span>{label}</span>
            </Button>
          );
        })}
      </div>
      <p role="status" className="sr-only">
        {pending === null
          ? ''
          : t('login.social.redirecting', { provider: t(`login.social.${pending}`) })}
      </p>
      {startable ? null : (
        <p id={noteId} className="text-xs text-muted-foreground">
          {t('login.social.startRequired')}
        </p>
      )}
      <p className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        <span>{t('login.social.or')}</span>
        <span className="h-px flex-1 bg-border" />
      </p>
    </section>
  );
}
