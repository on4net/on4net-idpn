/**
 * Distributed deny-list for access tokens (card #70 finding 14e).
 *
 * Access tokens are self-contained, so revoking one cannot revoke the JWT itself: the `jti` is
 * recorded instead and every consumer that must honour revocation checks it. Without this,
 * `/oauth2/revoke` with an access token answered `200` while `/oauth2/userinfo` kept accepting
 * the token until `exp` (`docs/api.md` 2.5).
 */
export interface TokenDenyList {
  /** Records a `jti` until its `exp`; the entry expires on its own afterwards. */
  deny(jti: string, expiresAtSeconds: number): Promise<void>;
  /** `true` when the `jti` was revoked and has not expired yet. */
  isDenied(jti: string): Promise<boolean>;
}

/** Key/value surface the deny-list needs (Redis in production, Map in tests). */
export interface DenyListStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

const DENY_KEY = 'idpn:jti-denied:';

/** Fallback lifetime when a token carries no usable `exp`. */
const DEFAULT_TTL_SECONDS = 900;

/**
 * Cache-backed deny-list. The TTL is derived from the token's own expiry, so the store never
 * grows beyond the set of currently valid revoked tokens.
 */
export function createTokenDenyList(
  store: DenyListStore,
  now: () => Date = () => new Date(),
): TokenDenyList {
  return {
    async deny(jti, expiresAtSeconds) {
      const remaining = Number.isFinite(expiresAtSeconds)
        ? Math.floor(expiresAtSeconds - now().getTime() / 1000)
        : DEFAULT_TTL_SECONDS;
      if (remaining <= 0) {
        // The token is already expired; nothing to remember.
        return;
      }
      await store.set(`${DENY_KEY}${jti}`, '1', Math.max(1, remaining));
    },

    async isDenied(jti) {
      return (await store.get(`${DENY_KEY}${jti}`)) !== null;
    },
  };
}

/** In-memory deny-list for tests and single-process deployments. */
export function createMemoryTokenDenyList(now: () => Date = () => new Date()): TokenDenyList {
  const entries = new Map<string, number>();
  return {
    async deny(jti, expiresAtSeconds) {
      const remaining = Number.isFinite(expiresAtSeconds)
        ? Math.floor(expiresAtSeconds - now().getTime() / 1000)
        : DEFAULT_TTL_SECONDS;
      if (remaining <= 0) {
        return;
      }
      entries.set(jti, now().getTime() + remaining * 1000);
    },

    async isDenied(jti) {
      const expiresAt = entries.get(jti);
      if (expiresAt === undefined) {
        return false;
      }
      if (expiresAt <= now().getTime()) {
        entries.delete(jti);
        return false;
      }
      return true;
    },
  };
}
