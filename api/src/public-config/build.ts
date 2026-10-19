import {
  publicClientConfigSchema,
  sanitizeIdpnTheme,
  type PublicClientConfig,
} from '@idpn/contracts';
import {
  directionOf,
  isDirection,
  isLocaleCode,
  normalizeLocale,
  type Direction,
  type Locale,
} from '@idpn/i18n/locale';

export interface PublicLoginContextBranding {
  title?: string;
  logoUrl?: string;
  /** Sanitized theme tokens; raw branding JSON never reaches the browser. */
  theme?: Record<string, unknown>;
}

export interface PublicLoginContext {
  key: string;
  name: string;
  description?: string | null;
  methods: string[];
  mfaPolicy: 'optional' | 'required_admins' | 'required_all';
  registrationPolicy?: 'invite_only' | 'self_service' | 'disabled';
  /** Optional presentation override; raw admin JSON, sanitized by the builder (docs/design-system.md 5.1). */
  branding?: unknown;
}

export interface PublicSocialProvider {
  provider: 'google' | 'facebook';
  label: string;
}

/** Everything the public config endpoint is allowed to read from a client row. */
export interface PublicClientSource {
  clientId: string;
  name: string;
  status: 'active' | 'disabled';
  locales: {
    default?: string;
    supported?: string[];
    dir?: Record<string, 'rtl' | 'ltr'>;
    version?: string;
  };
  branding: {
    logoUrl?: string;
    /** Raw JSON from the client row; sanitized before it reaches the public payload. */
    theme?: unknown;
    primaryColor?: string;
    radius?: string;
    fontFamily?: unknown;
  };
  registrationPolicy: 'invite_only' | 'self_service' | 'disabled';
  mfaPolicy: 'optional' | 'required_admins' | 'required_all';
  defaultLoginContextKey: string | null;
  mfeFeatures: Record<string, unknown>;
  /** Whether MFA is available for at least one factor type on this client. */
  mfaFeaturesEnabled?: boolean;
  loginContexts: PublicLoginContext[];
  socialProviders: PublicSocialProvider[];
}

export interface PublicConfigDependencies {
  translationsUrl?: string;
  mfe: { version: string; remoteEntry: string };
}

const DEFAULT_LOCALE: Locale = 'fa-IR';
const SOCIAL_LABELS: Record<PublicSocialProvider['provider'], string> = {
  google: 'Google',
  facebook: 'Facebook',
};
const LOGIN_METHODS = new Set(['password', 'google', 'facebook', 'otp', 'sso']);

function isLoginMethod(
  method: string,
): method is 'password' | 'google' | 'facebook' | 'otp' | 'sso' {
  return LOGIN_METHODS.has(method);
}

/** Bounds of the context presentation fields (docs/api.md 2.7). */
const MAX_CONTEXT_TITLE_LENGTH = 120;
const MAX_CONTEXT_LOGO_URL_LENGTH = 2048;

/** Newlines/tabs in a title would break the single-line header; reject them outright. */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Context `branding` is admin-authored JSON and is not shape-validated on write, so only
 * the documented presentation fields are copied: a plain-text title, an `http(s)` logo URL
 * and theme tokens sanitized by the shared contract. Anything else is dropped, so a stored
 * `url(...)`, `javascript:` or unknown field can never reach the browser.
 */
function sanitizeContextBranding(raw: unknown): PublicLoginContextBranding | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;

  const rawTitle = source['title'];
  const title =
    typeof rawTitle === 'string' &&
    rawTitle.trim() !== '' &&
    rawTitle.trim().length <= MAX_CONTEXT_TITLE_LENGTH &&
    !hasControlCharacters(rawTitle)
      ? rawTitle.trim()
      : undefined;

  let logoUrl: string | undefined;
  const rawLogo = source['logoUrl'];
  if (
    typeof rawLogo === 'string' &&
    rawLogo.trim() !== '' &&
    rawLogo.trim().length <= MAX_CONTEXT_LOGO_URL_LENGTH
  ) {
    try {
      const parsed = new URL(rawLogo.trim());
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        logoUrl = parsed.toString();
      }
    } catch {
      // Not an absolute URL: leave the logo out instead of failing the whole config.
    }
  }

  const theme = sanitizeIdpnTheme(source['theme']);
  const branding: PublicLoginContextBranding = {
    ...(title === undefined ? {} : { title }),
    ...(logoUrl === undefined ? {} : { logoUrl }),
    ...(Object.keys(theme).length === 0 ? {} : { theme: theme as Record<string, unknown> }),
  };
  return Object.keys(branding).length === 0 ? undefined : branding;
}

interface SanitizedLocales {
  default: string;
  supported: string[];
  dir: Record<string, Direction>;
}

/**
 * The client row is admin input and may predate validation. Values that are not locale
 * codes are dropped, duplicates are folded, a default outside `supported` falls back to
 * the first enabled locale, and a direction is always derived unless a valid override was
 * stored (docs/localization.md 3 and 6.1).
 */
function sanitizeLocales(locales: PublicClientSource['locales']): SanitizedLocales {
  const supported: string[] = [];
  const requestedSupported = Array.isArray(locales.supported)
    ? locales.supported
    : [DEFAULT_LOCALE];
  for (const value of requestedSupported) {
    const normalized = normalizeLocale(value);
    if (
      normalized !== undefined &&
      isLocaleCode(normalized) &&
      !supported.some((locale) => locale.toLowerCase() === normalized.toLowerCase())
    ) {
      supported.push(normalized);
    }
  }
  if (supported.length === 0) {
    supported.push(DEFAULT_LOCALE);
  }

  const requestedDefault = normalizeLocale(locales.default);
  const defaultLocale =
    (requestedDefault === undefined
      ? undefined
      : supported.find((locale) => locale.toLowerCase() === requestedDefault.toLowerCase())) ??
    supported[0] ??
    DEFAULT_LOCALE;

  const dir: Record<string, Direction> = {};
  const overrides =
    locales.dir !== null && typeof locales.dir === 'object' && !Array.isArray(locales.dir)
      ? locales.dir
      : {};
  for (const locale of supported) {
    const key = Object.keys(overrides).find(
      (candidate) => candidate.toLowerCase() === locale.toLowerCase(),
    );
    const override = key === undefined ? undefined : overrides[key];
    dir[locale] = isDirection(override) ? override : directionOf(locale);
  }

  return { default: defaultLocale, supported, dir };
}

/**
 * Builds the public client configuration (docs/api.md 2.7) and validates it against the
 * shared contract, so a field accidentally exposed by a repository change fails here
 * instead of leaking to the browser.
 */
export function buildPublicClientConfig(
  client: PublicClientSource,
  dependencies: PublicConfigDependencies,
): PublicClientConfig {
  const locales = sanitizeLocales(client.locales);
  const defaultLocale = locales.default;

  const rawTheme =
    typeof client.branding.theme === 'object' &&
    client.branding.theme !== null &&
    !Array.isArray(client.branding.theme)
      ? (client.branding.theme as Record<string, unknown>)
      : {};
  const theme = sanitizeIdpnTheme({
    ...rawTheme,
    ...(client.branding.primaryColor === undefined
      ? {}
      : { primary: client.branding.primaryColor }),
    ...(client.branding.radius === undefined ? {} : { radius: client.branding.radius }),
    ...(client.branding.fontFamily === undefined ? {} : { fontFamily: client.branding.fontFamily }),
  });

  const loginContexts = client.loginContexts.map((context) => {
    const branding = sanitizeContextBranding(context.branding);
    return {
      key: context.key,
      name: context.name,
      ...(context.description === undefined || context.description === null
        ? {}
        : { description: context.description }),
      methods: context.methods.filter(isLoginMethod),
      mfaPolicy: context.mfaPolicy,
      ...(context.registrationPolicy === undefined
        ? {}
        : { registrationPolicy: context.registrationPolicy }),
      ...(branding === undefined ? {} : { branding }),
    };
  });
  // The client row mirrors the default context key. Only publish it when that context is
  // actually active, otherwise the UI would offer a definition that no longer exists
  // (docs/login-contexts.md 7.1).
  const defaultLoginContext =
    client.defaultLoginContextKey !== null &&
    loginContexts.some((context) => context.key === client.defaultLoginContextKey)
      ? client.defaultLoginContextKey
      : undefined;

  const config: PublicClientConfig = {
    clientId: client.clientId,
    name: client.name,
    ...(client.branding.logoUrl === undefined ? {} : { logoUrl: client.branding.logoUrl }),
    locale: defaultLocale,
    locales: {
      ...locales,
      ...(client.locales.version === undefined ? {} : { version: client.locales.version }),
    },
    ...(dependencies.translationsUrl === undefined
      ? {}
      : { translationsUrl: dependencies.translationsUrl }),
    theme,
    registrationPolicy: client.registrationPolicy,
    mfaPolicy: client.mfaPolicy,
    loginContexts,
    ...(defaultLoginContext === undefined ? {} : { defaultLoginContext }),
    socialProviders: client.socialProviders
      .filter((provider) => provider.provider === 'google' || provider.provider === 'facebook')
      .map((provider) => ({
        provider: provider.provider,
        label: SOCIAL_LABELS[provider.provider],
      })),
    features: {
      userManagement: client.mfeFeatures.userManagement === true,
      selfServiceRegistration:
        client.mfeFeatures.selfServiceRegistration === true ||
        client.registrationPolicy === 'self_service',
      mfa: client.mfaFeaturesEnabled === true || client.mfaPolicy !== 'optional',
    },
    mfe: dependencies.mfe,
  };

  return publicClientConfigSchema.parse(config);
}
