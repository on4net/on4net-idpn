/**
 * Shared contract for social provider adapters (`docs/auth-flows.md` 9).
 *
 * Adapters are pure: they exchange an authorization code for a normalized profile and never
 * touch the database, the session store or an HTTP route. The per-app credentials are passed in
 * explicitly, so a callback for app A can only ever exchange a code with app A's client
 * (`docs/security.md` T23, T29).
 */

/** Providers implemented by adapters; mirrors the `SocialProvider` enum (`docs/domain-model.md` 2.6.1). */
export type SocialProviderId = 'google' | 'facebook';

/** Everything an adapter needs to redeem an authorization code. */
export interface AuthorizationCodeExchange {
  code: string;
  /** Must be byte-identical to the URI registered at the provider. */
  redirectUri: string;
  /** Provider client id of this app (`ClientSocialProvider.client_key`). */
  clientKey: string;
  /** Decrypted provider secret of this app; never logged and never returned to a browser. */
  clientSecret: string;
  /** PKCE verifier, when the start endpoint issued one (`docs/auth-flows.md` 9.4). */
  codeVerifier?: string;
  /** Expected nonce binding the response to this login attempt. */
  nonce?: string;
}

/** Provider-independent profile, ready for account linking in the callback flow (#36). */
export interface NormalizedSocialProfile {
  provider: SocialProviderId;
  providerUserId: string;
  email: string | null;
  /**
   * True only when the provider made a positive, verifiable statement about the email.
   * Facebook never does, so its profiles always carry `false` (see `facebook.ts`).
   */
  emailVerified: boolean;
  /** Never empty: falls back to the email local part, then to `providerUserId`. */
  displayName: string;
  avatarUrl: string | null;
  locale: string | null;
  /**
   * Provider payload for diagnostics. Adapters leave it unset on purpose: nothing from the
   * provider is persisted by default, and provider tokens must never be stored
   * (`docs/auth-flows.md` 9.4).
   */
  raw?: Record<string, unknown>;
}

export interface SocialProviderAdapter {
  readonly provider: SocialProviderId;
  exchangeAuthorizationCode(input: AuthorizationCodeExchange): Promise<NormalizedSocialProfile>;
}

/**
 * Safe, internal error codes. The callback flow maps these to the public social errors of
 * `docs/auth-flows.md` 9.5 without ever forwarding a provider message or HTTP body.
 */
export type SocialAdapterErrorCode =
  'invalid_grant' | 'provider_unavailable' | 'invalid_response' | 'email_unverified';

export interface SocialAdapterErrorOptions {
  /** True when a later attempt could still succeed (network, 5xx, 429). */
  retryable?: boolean;
  cause?: unknown;
}

/**
 * Adapter failure. Messages are built by the adapters themselves from operation names and HTTP
 * status codes only, so a provider body, authorization code, token or secret can never leak
 * through an error message or log line.
 */
export class SocialAdapterError extends Error {
  override readonly name = 'SocialAdapterError';
  readonly code: SocialAdapterErrorCode;
  readonly provider: SocialProviderId;
  readonly retryable: boolean;

  constructor(
    code: SocialAdapterErrorCode,
    provider: SocialProviderId,
    message: string,
    options: SocialAdapterErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.provider = provider;
    this.retryable = options.retryable ?? false;
  }
}

/** Refuses profiles that cannot be linked by email (`docs/auth-flows.md` 9.3). */
export function assertVerifiedEmail(
  profile: NormalizedSocialProfile,
): NormalizedSocialProfile & { email: string } {
  if (profile.email === null) {
    throw new SocialAdapterError(
      'email_unverified',
      profile.provider,
      'provider did not return an email address',
    );
  }
  if (!profile.emailVerified) {
    throw new SocialAdapterError(
      'email_unverified',
      profile.provider,
      'provider email is not verified',
    );
  }
  return { ...profile, email: profile.email };
}

const MAX_EMAIL_LENGTH = 320;
const MAX_USER_ID_LENGTH = 255;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_LOCALE_LENGTH = 35;
const MAX_URL_LENGTH = 2048;
const LOCALE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

/** Control characters would corrupt logs and storage; reject them explicitly (no regex). */
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
 * Provider identifiers become `Identity.provider_user_id`; reject anything that is not a plain,
 * bounded token instead of persisting an unexpected blob.
 */
export function normalizeProviderUserId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_USER_ID_LENGTH) {
    return null;
  }
  return hasControlCharacters(id) || /\s/.test(id) ? null : id;
}

/**
 * Emails are used for account linking, so a malformed value is dropped rather than repaired.
 * The original case is preserved; the linking flow compares addresses case-insensitively.
 */
export function normalizeSocialEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const email = value.trim();
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) {
    return null;
  }
  if (hasControlCharacters(email) || /\s/.test(email)) {
    return null;
  }
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) {
    return null;
  }
  return email;
}

/** Keeps locale tags short and structurally valid before they reach storage or the UI. */
export function normalizeLocale(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const locale = value.trim();
  if (locale.length === 0 || locale.length > MAX_LOCALE_LENGTH || !LOCALE.test(locale)) {
    return null;
  }
  return locale;
}

/**
 * Avatar URLs are rendered by the Hosted UI, so only absolute http(s) URLs are accepted;
 * `javascript:` and `data:` values are dropped.
 */
export function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAX_URL_LENGTH) {
    return null;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Display name falls back deterministically so the UI always has something to render. */
export function resolveDisplayName(
  name: unknown,
  email: string | null,
  providerUserId: string,
): string {
  const candidate = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (candidate.length > 0) {
    return candidate.slice(0, MAX_DISPLAY_NAME_LENGTH);
  }
  if (email !== null) {
    const localPart = email.slice(0, email.indexOf('@')).trim();
    if (localPart.length > 0) {
      return localPart.slice(0, MAX_DISPLAY_NAME_LENGTH);
    }
  }
  return providerUserId.slice(0, MAX_DISPLAY_NAME_LENGTH);
}
