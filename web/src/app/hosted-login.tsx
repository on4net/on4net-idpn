import * as React from 'react';

import { sanitizeIdpnTheme, type IdpnTheme } from '@idpn/contracts/theme';
import { IDPN_MFE_EVENT_NAME, type IdpnEvent } from '@idpn/mfe-sdk';
import { translate } from '@idpn/i18n';

import { IdpnRoot } from '@/app/idpn-root';
import { HostedLoginSkeleton } from '@/app/hosted-login-skeleton';
import { LanguageSwitcher } from '@/app/language-switcher';
import {
  ForgotPasswordPage,
  SetPasswordPage,
  VerifyEmailPage,
  type AccountFlowResult,
  type SetPasswordMode,
} from '@/app/account-flows';
import { LoginForm, type LoginFormValues } from '@/app/login-form';
import {
  contextAllowsPassword,
  resolveLoginContext,
  sanitizeLoginContexts,
  withLoginContext,
  withUiLocales,
} from '@/app/login-context';
import {
  LoginContextMethodNotice,
  LoginContextPanel,
  LoginContextSelector,
} from '@/app/login-context-selector';
import { MfaForm, type MfaErrorCode, type MfaFormValues } from '@/app/mfa-form';
import { browserPasskeyDriver, passkeysSupported, type PasskeyDriver } from '@/mfe/passkey-client';
import {
  SocialLogin,
  selectSocialProviders,
  socialErrorMessageKey,
  type SocialProviderSummary,
} from '@/app/social-login';
import { resolveDirection, resolveLocale, type Locale } from '@/i18n';
import {
  fetchClientBundle,
  sanitizeClientBundle,
  supportedClientLocales,
  type ClientBundleInput,
} from '@/i18n/client-bundle';
import { TranslationProvider, type TranslationOverrides } from '@/i18n/translation-context';

interface PublicConfigLike {
  locale?: string;
  locales?: {
    default?: string;
    supported?: string[];
    dir?: Record<string, 'rtl' | 'ltr'>;
  };
  /** Public location of the per-client bundle (docs/api.md 2.7). */
  translationsUrl?: string;
  /** Untrusted JSON from the public-config endpoint; sanitized before it reaches the root. */
  theme?: unknown;
  /** Untrusted context list; validated by `sanitizeLoginContexts` before rendering. */
  loginContexts?: unknown;
  /** Key of the context marked `is_default` on the server (active contexts only). */
  defaultLoginContext?: string;
  socialProviders?: SocialProviderSummary[];
}

/** Outcome of the password step (`POST /api/v1/login`). */
export type LoginSubmitResult =
  | { ok: true; redirectTo?: string }
  | { ok: false; reason: 'invalid_credentials' | 'network' | 'rate_limited' }
  | { ok: false; reason: 'mfa_required'; challengeToken: string; methods?: string[] }
  | { ok: false; reason: 'mfa_enrollment_required' };

export interface MfaVerifyInput extends MfaFormValues {
  challengeToken: string;
}

export type MfaVerifyResult =
  { ok: true; redirectTo?: string } | { ok: false; reason: MfaErrorCode };

export interface HostedLoginPageProps {
  /** Reads the query string; injectable for tests. */
  search?: string;
  /** Browser preference; injectable so tests never depend on the host machine. */
  acceptLanguage?: string;
  fetchConfig?: (clientId: string) => Promise<PublicConfigLike | null>;
  submit?: (
    values: LoginFormValues & { clientId?: string; loginContext?: string; returnTo?: string },
  ) => Promise<LoginSubmitResult>;
  /** Second-factor call (`POST /api/v1/login/mfa/verify`); injectable for tests. */
  verify?: (values: MfaVerifyInput) => Promise<MfaVerifyResult>;
  /** Passkey second-factor call; the default uses the browser WebAuthn API. */
  verifyPasskey?: (input: {
    challengeToken: string;
    driver: PasskeyDriver;
  }) => Promise<MfaVerifyResult>;
  /** WebAuthn browser implementation; injectable so tests never need an authenticator. */
  passkeys?: PasskeyDriver;
  /** Account lifecycle calls, injectable for tests (tokens never leave component memory). */
  forgotPassword?: (email: string) => Promise<AccountFlowResult>;
  setPassword?: (input: {
    token: string;
    password: string;
    mode: SetPasswordMode;
  }) => Promise<AccountFlowResult>;
  confirmEmail?: (token: string) => Promise<AccountFlowResult>;
  /** Called with a safe redirect target; defaults to `window.location.assign`. */
  navigate?: (target: string) => void;
  /** Bundle call, injectable for tests; returns the untrusted JSON body. */
  fetchBundle?: (input: ClientBundleInput) => Promise<unknown>;
}

const DEFAULT_THEME: IdpnTheme = {};
type ConfigState = 'loading' | 'ready' | 'error';
type BundleState = 'idle' | 'loading' | 'ready' | 'error';

/** `Accept-Language` of the browser; empty during SSR and in non-browser environments. */
function browserAcceptLanguage(): string {
  if (typeof navigator === 'undefined') {
    return '';
  }
  const languages = navigator.languages;
  if (Array.isArray(languages) && languages.length > 0) {
    return languages.join(',');
  }
  return navigator.language ?? '';
}

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

/** Default bundle call; the body is validated by `sanitizeClientBundle` before rendering. */
async function defaultFetchBundle(input: ClientBundleInput): Promise<unknown> {
  return fetchClientBundle(input);
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
  if (response.status === 429) {
    return { ok: false, reason: 'rate_limited' };
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
    methods?: unknown;
    redirectTo?: unknown;
  };
  if (payload.mfa === 'challenge' && typeof payload.challengeToken === 'string') {
    return {
      ok: false,
      reason: 'mfa_required',
      challengeToken: payload.challengeToken,
      methods: Array.isArray(payload.methods)
        ? payload.methods.filter((entry): entry is string => typeof entry === 'string')
        : [],
    };
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
 * Passkey second factor. The browser prompt is the only place the authenticator is touched;
 * the server issues a single-use ceremony bound to the pending MFA challenge and verifies
 * the signed assertion. Nothing from the response is persisted in the page.
 */
async function defaultVerifyPasskey(input: {
  challengeToken: string;
  driver: PasskeyDriver;
}): Promise<MfaVerifyResult> {
  if (!passkeysSupported(input.driver)) {
    return { ok: false, reason: 'passkey_unsupported' };
  }
  let optionsResponse: Response;
  try {
    optionsResponse = await fetch('/api/v1/login/mfa/webauthn/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ challengeToken: input.challengeToken }),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (optionsResponse.status === 401) {
    return { ok: false, reason: 'expired' };
  }
  if (!optionsResponse.ok) {
    return { ok: false, reason: 'passkey_failed' };
  }
  const ceremony = (await optionsResponse.json().catch((): null => null)) as {
    challengeId?: unknown;
    options?: unknown;
  } | null;
  if (typeof ceremony?.challengeId !== 'string' || ceremony.options === undefined) {
    return { ok: false, reason: 'passkey_failed' };
  }
  let response: unknown;
  try {
    response = await input.driver.authenticate(
      ceremony.options as Parameters<PasskeyDriver['authenticate']>[0],
    );
  } catch {
    return { ok: false, reason: 'passkey_failed' };
  }

  let verifyResponse: Response;
  try {
    verifyResponse = await fetch('/api/v1/login/mfa/webauthn/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        challengeToken: input.challengeToken,
        challengeId: ceremony.challengeId,
        response,
      }),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (verifyResponse.status === 429) {
    return { ok: false, reason: 'rate_limited' };
  }
  if (verifyResponse.status === 401 || verifyResponse.status === 400) {
    const problem = (await verifyResponse.json().catch((): unknown => null)) as {
      error?: unknown;
    } | null;
    return problem?.error === 'mfa_challenge_invalid'
      ? { ok: false, reason: 'expired' }
      : { ok: false, reason: 'passkey_failed' };
  }
  if (!verifyResponse.ok) {
    return { ok: false, reason: 'network' };
  }
  const payload = (await verifyResponse.json()) as { redirectTo?: unknown };
  return typeof payload.redirectTo === 'string'
    ? { ok: true, redirectTo: payload.redirectTo }
    : { ok: true };
}

/**
 * Request a reset link. The server answers `202` for every address; the UI shows one
 * neutral message and never probes whether an account exists.
 */
async function defaultForgotPassword(email: string): Promise<AccountFlowResult> {
  let response: Response;
  try {
    response = await fetch('/api/v1/account/password/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email }),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (response.status === 429) {
    return { ok: false, error: 'rate_limited' };
  }
  if (!response.ok) {
    return { ok: false, error: response.status >= 500 ? 'network' : 'server' };
  }
  return { ok: true };
}

async function defaultSetPassword(input: {
  token: string;
  password: string;
  mode: SetPasswordMode;
}): Promise<AccountFlowResult> {
  const path =
    input.mode === 'invite' ? '/api/v1/account/invite/accept' : '/api/v1/account/password/reset';
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token: input.token, password: input.password }),
    });
  } catch {
    return { ok: false, error: 'network' };
  }

  if (response.status === 429) {
    return { ok: false, error: 'rate_limited' };
  }
  if (response.status === 400) {
    return { ok: false, error: 'invalid_token' };
  }
  if (response.status === 422) {
    const problem = (await response.json().catch((): unknown => null)) as {
      code?: unknown;
      violations?: unknown;
    } | null;
    if (problem?.code === 'password_policy') {
      return {
        ok: false,
        error: 'password_policy',
        violations: Array.isArray(problem.violations)
          ? problem.violations.filter((entry): entry is string => typeof entry === 'string')
          : [],
      };
    }
    return { ok: false, error: 'server' };
  }
  if (!response.ok) {
    return { ok: false, error: response.status >= 500 ? 'network' : 'server' };
  }
  return { ok: true };
}

async function defaultConfirmEmail(token: string): Promise<AccountFlowResult> {
  let response: Response;
  try {
    response = await fetch('/api/v1/account/email/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token }),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (response.status === 400) {
    return { ok: false, error: 'invalid_token' };
  }
  if (!response.ok) {
    return { ok: false, error: response.status >= 500 ? 'network' : 'server' };
  }
  return { ok: true };
}

/**
 * Only a rooted path or an absolute URL on the IdP origin may be a navigation target. The API
 * already validates `return_to`, but re-checking here keeps `javascript:` payloads and
 * off-site redirects from ever reaching `window.location` (docs/security.md T5, T15).
 */
export function safeRedirectTarget(value: string | undefined): string {
  if (value === undefined || value === '') {
    return '/';
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
    return trimmed;
  }
  try {
    const candidate = new URL(trimmed);
    if (typeof window !== 'undefined' && candidate.origin === window.location.origin) {
      return candidate.toString();
    }
  } catch {
    // Not an absolute URL: fall through to the safe default.
  }
  return '/';
}

/**
 * Hosted Auth UI page: reads `client_id`, `return_to`, `ui_locales` and `login_hint`, applies
 * the client theme and renders the localized login form. No token ever reaches this page —
 * only the HttpOnly `idpn_session` cookie set by the API on success.
 */
export function HostedLoginPage({
  search,
  acceptLanguage,
  fetchConfig = defaultFetchConfig,
  submit = defaultSubmit,
  verify = defaultVerify,
  verifyPasskey = defaultVerifyPasskey,
  passkeys = browserPasskeyDriver,
  forgotPassword = defaultForgotPassword,
  setPassword = defaultSetPassword,
  confirmEmail = defaultConfirmEmail,
  navigate,
  fetchBundle = defaultFetchBundle,
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
  /** Account lifecycle flows: forgot, invite set-password, reset and email verification. */
  const action = params.get('action');
  const flowToken = params.get('token') ?? undefined;

  const [config, setConfig] = React.useState<PublicConfigLike | null>(null);
  const [configState, setConfigState] = React.useState<ConfigState>(
    clientId === undefined ? 'ready' : 'loading',
  );
  const [bundleState, setBundleState] = React.useState<BundleState>('idle');
  /** Validated bundles per locale; module memory only, never localStorage/sessionStorage. */
  const [translations, setTranslations] = React.useState<TranslationOverrides>({});
  const [bootstrapped, setBootstrapped] = React.useState(false);
  const [locale, setLocale] = React.useState<Locale>(() =>
    // Explicit `ui_locales` is safe before the config arrives. The browser preference is
    // applied only after the client's enabled list is known (the form is still behind the
    // skeleton at that point), so an unenabled locale can never be painted.
    resolveLocale({ uiLocales }),
  );
  const [theme, setTheme] = React.useState<IdpnTheme>(DEFAULT_THEME);
  const [submitting, setSubmitting] = React.useState(false);
  const [errorCode, setErrorCode] = React.useState<
    'invalid_credentials' | 'network' | 'rate_limited' | 'mfa_enrollment_required' | null
  >(null);
  /** Set once the password step returned an MFA challenge (single-use token). */
  const [challengeToken, setChallengeToken] = React.useState<string | null>(null);
  const [mfaMethods, setMfaMethods] = React.useState<string[]>([]);
  const [mfaSubmitting, setMfaSubmitting] = React.useState(false);
  const [passkeySubmitting, setPasskeySubmitting] = React.useState(false);
  const [mfaError, setMfaError] = React.useState<MfaErrorCode | null>(null);

  React.useEffect(() => {
    if (clientId === undefined) {
      setConfigState('ready');
      return;
    }
    const preference = acceptLanguage ?? browserAcceptLanguage();
    let cancelled = false;
    setConfigState('loading');
    setBundleState('idle');
    // Never reuse another client's bundle if `client_id` changes in place.
    setTranslations({});
    void fetchConfig(clientId)
      .then((loaded) => {
        if (cancelled) {
          return;
        }
        if (loaded === null) {
          // Missing/disabled client: keep an explicit ui_locales choice when it is a
          // shipped base locale, otherwise fall back to the platform default.
          setConfig(null);
          setTheme({});
          setConfigState('error');
          // Without a config the client's enabled locales are unknown: honour a valid
          // explicit ui_locales, then use the platform default (never the browser list,
          // which could select a locale this client does not enable).
          setLocale(resolveLocale({ uiLocales }));
          return;
        }
        setConfig(loaded);
        setTheme(sanitizeIdpnTheme(loaded.theme));
        setConfigState('ready');
        setLocale(
          resolveLocale({
            uiLocales,
            acceptLanguage: preference,
            clientDefault: loaded.locales?.default ?? loaded.locale,
            supported: loaded.locales?.supported,
          }),
        );
      })
      .catch(() => {
        // A missing public config must not block login; base locale + bundle are used.
        if (cancelled) {
          return;
        }
        setConfig(null);
        setTheme({});
        setConfigState('error');
        setLocale(resolveLocale({ uiLocales }));
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, fetchConfig, uiLocales, acceptLanguage]);

  const translationsUrl = config?.translationsUrl;

  /**
   * Lazy per-locale bundle load. The server bundle already merges base + overrides; the
   * browser re-validates it and always keeps the shared base as the final fallback, so a
   * failed or malformed bundle can never block the login form.
   */
  React.useEffect(() => {
    if (configState !== 'ready' || clientId === undefined || translationsUrl === undefined) {
      setBundleState('idle');
      return;
    }
    const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
    let cancelled = false;
    setBundleState('loading');
    void fetchBundle({
      clientId,
      locale,
      translationsUrl,
      ...(controller === undefined ? {} : { signal: controller.signal }),
    })
      .then((raw) => {
        if (cancelled) {
          return;
        }
        const bundle = sanitizeClientBundle(raw, locale);
        if (bundle === null) {
          setBundleState('error');
          return;
        }
        setTranslations((current) => ({ ...current, [locale]: bundle }));
        setBundleState('ready');
      })
      .catch((error: unknown) => {
        if (cancelled || (error as { name?: string } | null)?.name === 'AbortError') {
          return;
        }
        setBundleState('error');
      });
    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [configState, clientId, locale, translationsUrl, fetchBundle]);

  React.useEffect(() => {
    if (configState !== 'loading' && bundleState !== 'loading') {
      setBootstrapped(true);
    }
  }, [configState, bundleState]);

  const enabledLocales = React.useMemo(() => supportedClientLocales(config), [config]);

  /**
   * Login contexts of this client. The public config only publishes `active` contexts and
   * every entry is re-validated here, so a disabled or malformed context can never be
   * offered (`docs/login-contexts.md` 4.2, 6).
   */
  const loginContexts = React.useMemo(() => sanitizeLoginContexts(config?.loginContexts), [config]);
  /** In-page choice; `login_context` from the redirect still wins as the app's own choice. */
  const [selectedContextKey, setSelectedContextKey] = React.useState<string | undefined>(undefined);
  const resolution = React.useMemo(
    () =>
      resolveLoginContext({
        contexts: loginContexts,
        requestedKey: loginContext,
        selectedKey: selectedContextKey,
        defaultKey: config?.defaultLoginContext,
      }),
    [loginContexts, loginContext, selectedContextKey, config?.defaultLoginContext],
  );
  const activeContext = resolution.context;
  const activeContextKey = activeContext?.key;

  /**
   * Context theme is applied over the client theme (docs/design-system.md 5.1). Both sides
   * are sanitized tokens, so switching context never writes raw CSS and keeps the
   * documented fallbacks.
   */
  const effectiveTheme = React.useMemo((): IdpnTheme => {
    const contextTheme = activeContext?.branding?.theme;
    if (contextTheme === undefined) {
      return theme;
    }
    return sanitizeIdpnTheme({ ...(theme as Record<string, unknown>), ...contextTheme });
  }, [theme, activeContext]);
  const requiresBundle =
    configState === 'ready' && clientId !== undefined && translationsUrl !== undefined;
  const bundleResolved =
    !requiresBundle || translations[locale] !== undefined || bundleState === 'error';
  /** First paint gate: config + the first bundle must settle before the form is shown. */
  const showSkeleton =
    configState === 'loading' || (requiresBundle && !bundleResolved && !bootstrapped);

  /**
   * Link back to the plain login form while keeping the client parameters. The token is
   * never copied into this link, and the active locale is pinned so a language switch
   * survives the forgot-password round trip.
   */
  const backHref = React.useMemo(() => {
    const back = new URLSearchParams();
    if (clientId !== undefined) {
      back.set('client_id', clientId);
    }
    back.set('ui_locales', locale);
    return `?${back.toString()}`;
  }, [clientId, locale]);
  const forgotHref = React.useMemo(() => {
    const target = new URLSearchParams(backHref.startsWith('?') ? backHref.slice(1) : '');
    target.set('action', 'forgot-password');
    return `?${target.toString()}`;
  }, [backHref]);

  const dir = resolveDirection(locale, config?.locales?.dir?.[locale]);

  /**
   * The Hosted UI owns the document, so the document language/direction follow the
   * resolved locale. Embedded MFE roots only set attributes on their own root. While the
   * config is loading the document keeps its initial attributes, so no wrong-direction
   * form can paint before the resolved values are known.
   */
  React.useEffect(() => {
    if (typeof document === 'undefined' || configState === 'loading') {
      return;
    }
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    // The tab and a screen reader announce the document title, which must follow the page
    // language rather than the hardcoded Persian title in index.html (card #60).
    document.title = translate(locale, 'login.title', {}, { messages: translations });
  }, [locale, dir, configState, translations]);

  /**
   * User-driven language change. The authorize request is preserved: only `ui_locales`
   * is rewritten in place (no reload), so `return_to`, `login_request` and the rest of
   * the OIDC query stay intact. Unsupported locales are rejected before any state change.
   */
  const changeLocale = (next: Locale): void => {
    if (next === locale || !enabledLocales.includes(next)) {
      return;
    }
    setLocale(next);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('ui_locales', next);
      // Bind the choice into the preserved authorize request too, so the IdP issues the token
      // for the language the user actually picked instead of dropping it on submit (card #60).
      const bound = withUiLocales(url.searchParams.get('return_to') ?? undefined, next);
      if (bound !== undefined) {
        url.searchParams.set('return_to', bound);
      }
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
    if (typeof document !== 'undefined') {
      const detail: IdpnEvent = {
        type: 'locale:changed',
        locale: next,
        dir: resolveDirection(next, config?.locales?.dir?.[next]),
      };
      document.dispatchEvent(
        new CustomEvent<IdpnEvent>(IDPN_MFE_EVENT_NAME, { detail, bubbles: true }),
      );
    }
  };

  /**
   * User-driven context change. The authorize request is preserved: only `login_context`
   * is added to the original `/oauth2/authorize` URL (`return_to`), so `state`, `nonce`,
   * the PKCE challenge and `login_hint` survive untouched. The page URL is updated in
   * place for deep links and no form field is remounted, so typed input is kept.
   */
  const changeContext = (next: string): void => {
    const target = loginContexts.find((candidate) => candidate.key === next);
    if (target === undefined || target.key === activeContextKey) {
      return;
    }
    setSelectedContextKey(target.key);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('login_context', target.key);
      const bound = withLoginContext(url.searchParams.get('return_to') ?? undefined, target.key);
      if (bound !== undefined) {
        url.searchParams.set('return_to', bound);
      }
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
    if (typeof document !== 'undefined') {
      const detail: IdpnEvent = { type: 'context:changed', loginContext: target.key };
      document.dispatchEvent(
        new CustomEvent<IdpnEvent>(IDPN_MFE_EVENT_NAME, { detail, bubbles: true }),
      );
    }
  };

  const socialProviders = selectSocialProviders(
    config?.socialProviders,
    loginContexts,
    activeContextKey,
  );
  const socialErrorKey = socialErrorMessageKey(socialError);
  const showSocial = socialProviders.length > 0 || socialErrorKey !== null;
  const allowsPassword = contextAllowsPassword(activeContext);

  const navigateTo = (target: string): void => {
    if (navigate !== undefined) {
      navigate(target);
    } else if (typeof window !== 'undefined') {
      window.location.assign(target);
    }
  };

  /**
   * The only navigation target is the `redirectTo` value returned by the API, which mirrors a
   * `return_to` the server validated (same origin or a rooted path). Never fall back to the
   * raw query value: `return_to=javascript:...` or `//evil.example` would otherwise run on the
   * IdP origin / redirect off-site after a successful login (docs/security.md T5, T15).
   */
  const redirectTarget = (value: string | undefined): string => safeRedirectTarget(value);

  const handleSubmit = async (values: LoginFormValues) => {
    setSubmitting(true);
    setErrorCode(null);
    try {
      /**
       * The effective context is sent with the credentials because the API resolves the
       * context MFA policy from it, and the authorize URL is bound to the same context so
       * the issued token carries `login_context` (docs/login-contexts.md 4.1, 6).
       */
      const boundReturnTo = withLoginContext(returnTo, activeContextKey);
      const result = await submit({
        ...values,
        ...(clientId === undefined ? {} : { clientId }),
        ...(activeContextKey === undefined ? {} : { loginContext: activeContextKey }),
        ...(boundReturnTo === undefined ? {} : { returnTo: boundReturnTo }),
      });
      if (!result.ok) {
        if (result.reason === 'mfa_required') {
          // No session and no cookie yet: the second factor completes the login.
          setMfaError(null);
          setMfaMethods(result.methods ?? []);
          setChallengeToken(result.challengeToken);
          return;
        }
        setErrorCode(result.reason);
        return;
      }
      navigateTo(redirectTarget(result.redirectTo));
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
      navigateTo(redirectTarget(result.redirectTo));
    } finally {
      setMfaSubmitting(false);
    }
  };

  const backToPassword = (): void => {
    // The challenge stays valid server-side until its TTL, but the browser drops the token.
    setChallengeToken(null);
    setMfaMethods([]);
    setMfaError(null);
  };

  const handlePasskey = async (): Promise<void> => {
    if (challengeToken === null) {
      return;
    }
    setPasskeySubmitting(true);
    setMfaError(null);
    try {
      const result = await verifyPasskey({ challengeToken, driver: passkeys });
      if (!result.ok) {
        setMfaError(result.reason);
        return;
      }
      navigateTo(redirectTarget(result.redirectTo));
    } finally {
      setPasskeySubmitting(false);
    }
  };

  const flowView =
    action === 'forgot-password' ? (
      <ForgotPasswordPage locale={locale} backHref={backHref} onSubmit={forgotPassword} />
    ) : action === 'set-password' || action === 'reset-password' ? (
      <SetPasswordPage
        locale={locale}
        mode={action === 'set-password' ? 'invite' : 'reset'}
        token={flowToken}
        backHref={backHref}
        onSubmit={setPassword}
      />
    ) : action === 'verify-email' ? (
      <VerifyEmailPage
        locale={locale}
        token={flowToken}
        backHref={backHref}
        onConfirm={confirmEmail}
      />
    ) : null;

  const socialBlock =
    showSocial && challengeToken === null ? (
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
    ) : undefined;

  const content =
    flowView ??
    (challengeToken === null ? (
      allowsPassword ? (
        <LoginForm
          locale={locale}
          dir={dir}
          submitting={submitting}
          errorCode={errorCode}
          defaultIdentifier={loginHint}
          forgotHref={forgotHref}
          social={socialBlock}
          onSubmit={handleSubmit}
        />
      ) : (
        // A context may allow social sign-in without a password; the providers must still be
        // offered next to the notice, otherwise the page is a dead end (card #63 finding 1).
        <main
          dir={dir}
          className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-start shadow-sm"
        >
          <div className="grid gap-3" role="status" aria-live="polite">
            <LoginContextMethodNotice locale={locale} dir={dir} />
            {socialBlock === undefined ? null : socialBlock}
          </div>
        </main>
      )
    ) : (
      <MfaForm
        locale={locale}
        dir={dir}
        submitting={mfaSubmitting}
        errorCode={mfaError}
        passkeyAvailable={mfaMethods.includes('webauthn')}
        passkeySubmitting={passkeySubmitting}
        onPasskey={handlePasskey}
        onBack={backToPassword}
        onSubmit={handleVerify}
      />
    ));

  return (
    <IdpnRoot
      locale={locale}
      dir={dir}
      theme={effectiveTheme}
      data-client-id={clientId}
      data-config-state={configState}
      data-bundle-state={bundleState}
      aria-busy={showSkeleton || submitting || mfaSubmitting || passkeySubmitting}
    >
      <TranslationProvider locale={locale} messages={translations}>
        <div className="w-full max-w-sm" data-login-context={activeContextKey}>
          {configState === 'ready' ? (
            <LanguageSwitcher
              locale={locale}
              locales={enabledLocales}
              dir={dir}
              onChange={changeLocale}
            />
          ) : null}
          {showSkeleton || flowView !== null ? null : (
            <>
              {(resolution.requiresSelection || resolution.invalidRequested) &&
              challengeToken === null &&
              activeContextKey ? (
                <LoginContextSelector
                  locale={locale}
                  dir={dir}
                  contexts={loginContexts}
                  value={activeContextKey}
                  {...(config?.defaultLoginContext === undefined
                    ? {}
                    : { defaultKey: config.defaultLoginContext })}
                  invalidRequested={resolution.invalidRequested}
                  onChange={changeContext}
                />
              ) : null}
              {activeContext === undefined ? null : (
                <LoginContextPanel locale={locale} dir={dir} context={activeContext} />
              )}
            </>
          )}
          {showSkeleton ? <HostedLoginSkeleton locale={locale} /> : content}
        </div>
        {config === null ? null : <span hidden data-testid="public-config-loaded" />}
      </TranslationProvider>
    </IdpnRoot>
  );
}
