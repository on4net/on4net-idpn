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

export interface PublicLoginContext {
  key: string;
  name: string;
  description?: string | null;
  methods: string[];
  mfaPolicy: 'optional' | 'required_admins' | 'required_all';
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

  const loginContexts = client.loginContexts.map((context) => ({
    key: context.key,
    name: context.name,
    ...(context.description === undefined || context.description === null
      ? {}
      : { description: context.description }),
    methods: context.methods.filter(isLoginMethod),
    mfaPolicy: context.mfaPolicy,
  }));
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
