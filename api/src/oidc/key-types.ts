import type { JWK } from 'jose';

export type SigningKeyStatus = 'active' | 'retired' | 'revoked';

/** Signing key as stored (private material lives in KMS/Vault in production). */
export interface StoredSigningKey {
  kid: string;
  alg: 'ES256';
  /** Public JWK without private members. */
  publicJwk: JWK;
  /** Private JWK, only available to the key provider (never serialized into JWKS). */
  privateJwk: JWK;
  status: SigningKeyStatus;
  createdAt: Date;
  retiredAt?: Date | null;
}

export interface SigningKeyRepository {
  list(): Promise<StoredSigningKey[]>;
  save(key: StoredSigningKey): Promise<void>;
  updateStatus(kid: string, status: SigningKeyStatus, retiredAt?: Date): Promise<void>;
}

/** Public metadata of one signing key; never includes private key material. */
export interface SigningKeySummary {
  kid: string;
  alg: 'ES256';
  status: SigningKeyStatus;
  createdAt: Date;
  retiredAt: Date | null;
  /** True while the key is part of the published JWKS. */
  publishedInJwks: boolean;
}

/** Rotation/expiry health exposed to operators (`GET /api/v1/keys`). */
export interface SigningKeyHealth {
  keys: SigningKeySummary[];
  activeKey: {
    kid: string;
    createdAt: Date;
    ageDays: number;
  } | null;
  /**
   * True when the active key is older than the rotation threshold, i.e. a scheduled
   * rotation is overdue (or manual rotation should happen).
   */
  rotationDue: boolean;
  /** Age in days after which `rotationDue` becomes true. */
  rotationDueAfterDays: number;
}

/** Outcome of a rotation; only public identifiers, never key material. */
export interface KeyRotationResult {
  active: StoredSigningKey;
  previousKid: string | null;
  previousRevoked: boolean;
}

export interface SigningKeyManagerOptions {
  /**
   * How long a retired key stays in the JWKS after retirement. Must cover the longest
   * token lifetime so tokens issued just before rotation remain verifiable until expiry.
   */
  retiredRetentionSeconds?: number;
  /** Age in days at which `rotationDue` is reported; 0 disables the flag. */
  rotationDueAfterDays?: number;
  /**
   * In-process cache TTL for the key list and the published JWKS. Production key stores are
   * remote (KMS/Vault), so re-reading them on every JWKS, signing and verification request is
   * pure latency; the published document already carries `Cache-Control: max-age=300`. The
   * manager invalidates the cache on its own rotation/revocation, so an out-of-process
   * rotation is visible after at most this TTL. 0 disables caching.
   */
  keyCacheTtlSeconds?: number;
  /** Optional sink for lifecycle warnings (never receives key material). */
  onWarning?: (message: string) => void;
}

export interface PublicJwk extends JWK {
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

export interface JwksDocument {
  keys: PublicJwk[];
}

export interface SignedTokenOptions {
  issuer: string;
  audience: string | string[];
  expiresInSeconds: number;
  subject?: string;
  issuedAt?: number;
}

export interface VerifyOptions {
  issuer: string;
  audience?: string | string[];
  /** Injection point for deterministic tests; defaults to the wall clock. */
  currentDate?: Date;
}
