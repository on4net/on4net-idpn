/** Per-app social login credentials (`docs/domain-model.md` 2.6.1, `docs/api.md` 3.3.2). */

/** Providers the IdP knows how to drive. Extending the enum requires a migration. */
export const SOCIAL_PROVIDERS = ['google', 'facebook'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/** Minimum OIDC scopes documented for both providers. */
export const DEFAULT_SOCIAL_SCOPES: readonly string[] = ['openid', 'email', 'profile'];

/**
 * Exact callback URI for one app and provider. Providers compare it byte for byte, and it is
 * the only value an app admin registers in the Google/Facebook console.
 */
export function socialCallbackUrl(
  issuer: string,
  clientId: string,
  provider: SocialProvider,
): string {
  const base = issuer.replace(/\/+$/, '');
  return `${base}/oauth2/social/${encodeURIComponent(clientId)}/${provider}/callback`;
}

/** Public projection of a row. `clientSecretEncrypted` has no representation here. */
export interface SocialProviderRecord {
  id: string;
  provider: SocialProvider;
  clientKey: string;
  scopes: string[];
  allowedEmailDomains: string[];
  enabled: boolean;
  updatedAt: string;
}

export interface UpsertSocialProviderInput {
  clientKey: string;
  scopes: string[];
  allowedEmailDomains: string[];
  enabled: boolean;
  /** Fresh secret; omitted on update to keep the stored ciphertext. */
  clientSecretEncrypted?: Uint8Array<ArrayBuffer>;
}

export type SocialProviderRepositoryResult<T> =
  { ok: true; value: T } | { ok: false; reason: 'client-not-found' };

/**
 * Persistence port for the admin surface. Implementations must never expose
 * `clientSecretEncrypted` through `SocialProviderRecord`.
 */
export interface AdminSocialProviderRepository {
  list(clientId: string): Promise<SocialProviderRepositoryResult<SocialProviderRecord[]>>;
  find(
    clientId: string,
    provider: SocialProvider,
  ): Promise<SocialProviderRepositoryResult<SocialProviderRecord | null>>;
  upsert(
    clientId: string,
    provider: SocialProvider,
    input: UpsertSocialProviderInput,
  ): Promise<SocialProviderRepositoryResult<SocialProviderRecord>>;
  /** Hard delete: the credential must not linger after it is revoked. */
  remove(
    clientId: string,
    provider: SocialProvider,
  ): Promise<SocialProviderRepositoryResult<boolean>>;
}

/** Response shape of GET/PUT (`docs/api.md` 3.3.2); never contains the secret. */
export interface AdminSocialProvider {
  provider: SocialProvider;
  clientKey: string;
  scopes: string[];
  allowedEmailDomains: string[];
  enabled: boolean;
  callbackUrl: string;
  updatedAt: string;
}
