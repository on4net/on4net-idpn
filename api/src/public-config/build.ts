import { publicClientConfigSchema, type PublicClientConfig } from '@idpn/contracts';

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
    theme?: Record<string, string>;
    primaryColor?: string;
    radius?: string;
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

const DEFAULT_LOCALE = 'fa-IR';
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

function directionOf(locale: string): 'rtl' | 'ltr' {
  return locale.startsWith('fa') || locale.startsWith('ar') ? 'rtl' : 'ltr';
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
  const supported = client.locales.supported ?? [DEFAULT_LOCALE];
  const defaultLocale = client.locales.default ?? supported[0] ?? DEFAULT_LOCALE;
  const dir: Record<string, 'rtl' | 'ltr'> = {};
  for (const locale of supported) {
    dir[locale] = client.locales.dir?.[locale] ?? directionOf(locale);
  }

  const theme: Record<string, string> = { ...(client.branding.theme ?? {}) };
  if (client.branding.primaryColor !== undefined) {
    theme.primary = client.branding.primaryColor;
  }
  if (client.branding.radius !== undefined) {
    theme.radius = client.branding.radius;
  }

  const config: PublicClientConfig = {
    clientId: client.clientId,
    name: client.name,
    ...(client.branding.logoUrl === undefined ? {} : { logoUrl: client.branding.logoUrl }),
    locale: defaultLocale,
    locales: {
      default: defaultLocale,
      supported,
      dir,
      ...(client.locales.version === undefined ? {} : { version: client.locales.version }),
    },
    ...(dependencies.translationsUrl === undefined
      ? {}
      : { translationsUrl: dependencies.translationsUrl }),
    theme,
    registrationPolicy: client.registrationPolicy,
    mfaPolicy: client.mfaPolicy,
    loginContexts: client.loginContexts.map((context) => ({
      key: context.key,
      name: context.name,
      ...(context.description === undefined || context.description === null
        ? {}
        : { description: context.description }),
      methods: context.methods.filter(isLoginMethod),
      mfaPolicy: context.mfaPolicy,
    })),
    ...(client.defaultLoginContextKey === null
      ? {}
      : { defaultLoginContext: client.defaultLoginContextKey }),
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
