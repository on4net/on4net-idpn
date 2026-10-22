import {
  SignJWT,
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTVerifyResult,
} from 'jose';

import type {
  JwksDocument,
  KeyRotationResult,
  PublicJwk,
  SignedTokenOptions,
  SigningKeyHealth,
  SigningKeyManagerOptions,
  SigningKeyRepository,
  StoredSigningKey,
  VerifyOptions,
} from './key-types.js';

export const SIGNING_ALG = 'ES256' as const;

/** Default in-process cache window for the key list and the published JWKS (seconds). */
export const DEFAULT_KEY_CACHE_TTL_SECONDS = 30;

type LocalJwkSet = ReturnType<typeof createLocalJWKSet>;

/**
 * Default retention for retired keys: the longest access-token lifetime the Admin API
 * allows (`MAX_ACCESS_TOKEN_TTL` in admin/clients/client-validation.ts), i.e. one hour.
 */
export const DEFAULT_RETIRED_RETENTION_SECONDS = 3600;

/** Default age at which `rotationDue` is reported (docs/security.md T10: rotate every 90 days). */
export const DEFAULT_ROTATION_DUE_DAYS = 90;

/** Generates a fresh P-256 key pair with a deterministic `kid` (RFC 7638 thumbprint). */
export async function generateSigningKey(
  status: StoredSigningKey['status'] = 'active',
  now: Date = new Date(),
): Promise<StoredSigningKey> {
  const { publicKey, privateKey } = await generateKeyPair(SIGNING_ALG, { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(publicJwk, 'sha256');

  return {
    kid,
    alg: SIGNING_ALG,
    publicJwk,
    privateJwk,
    status,
    createdAt: now,
    retiredAt: null,
  };
}

/**
 * Manages ES256 signing keys: active key selection, JWKS publication (active + retired,
 * never revoked), rotation and local token verification.
 */
export class SigningKeyManager {
  private readonly retiredRetentionMs: number;
  private readonly rotationDueAfterDays: number;
  private readonly onWarning: ((message: string) => void) | undefined;
  private readonly cacheTtlMs: number;
  /** Bumped on every lifecycle write so an in-flight list cannot repopulate stale state. */
  private generation = 0;
  private keysCache: { keys: StoredSigningKey[]; expiresAt: number } | null = null;
  private keyListRequest: Promise<StoredSigningKey[]> | null = null;
  private ensureKeyRequest: Promise<StoredSigningKey> | null = null;
  private localCache: { signature: string; local: LocalJwkSet } | null = null;

  constructor(
    private readonly repository: SigningKeyRepository,
    private readonly now: () => Date = () => new Date(),
    options: SigningKeyManagerOptions = {},
  ) {
    this.retiredRetentionMs =
      (options.retiredRetentionSeconds ?? DEFAULT_RETIRED_RETENTION_SECONDS) * 1000;
    this.rotationDueAfterDays = options.rotationDueAfterDays ?? DEFAULT_ROTATION_DUE_DAYS;
    this.cacheTtlMs = (options.keyCacheTtlSeconds ?? DEFAULT_KEY_CACHE_TTL_SECONDS) * 1000;
    this.onWarning = options.onWarning;
  }

  /**
   * Reads the key store through a short-lived cache. Concurrent callers share one request,
   * so a cold JWKS burst does not multiply KMS reads.
   */
  private async loadKeys(): Promise<StoredSigningKey[]> {
    const now = this.now().getTime();
    if (this.keysCache !== null && now < this.keysCache.expiresAt) {
      return this.keysCache.keys;
    }
    if (this.keyListRequest !== null) {
      return this.keyListRequest;
    }
    const generation = this.generation;
    const request = this.repository.list().then((keys) => {
      if (generation === this.generation) {
        this.keysCache = { keys, expiresAt: this.now().getTime() + this.cacheTtlMs };
      }
      return keys;
    });
    this.keyListRequest = request;
    try {
      return await request;
    } finally {
      if (this.keyListRequest === request) {
        this.keyListRequest = null;
      }
    }
  }

  /** Drops the key/JWKS cache after a lifecycle write (rotation, revocation, first key). */
  private invalidate(): void {
    this.generation += 1;
    this.keysCache = null;
    this.localCache = null;
    this.keyListRequest = null;
  }

  /** Creates and persists a first active key when the store is empty. */
  async ensureKey(): Promise<StoredSigningKey> {
    // Concurrent cold-start requests share one provisioning attempt; otherwise two of them
    // could each observe an empty store and persist a second active key.
    if (this.ensureKeyRequest !== null) {
      return this.ensureKeyRequest;
    }
    const request = this.resolveActiveKey();
    this.ensureKeyRequest = request;
    try {
      return await request;
    } finally {
      if (this.ensureKeyRequest === request) {
        this.ensureKeyRequest = null;
      }
    }
  }

  private async resolveActiveKey(): Promise<StoredSigningKey> {
    const keys = await this.loadKeys();
    const active = keys.find((key) => key.status === 'active');
    if (active !== undefined) {
      return active;
    }
    const created = await generateSigningKey('active', this.now());
    await this.repository.save(created);
    this.invalidate();
    return created;
  }

  async activeKey(): Promise<StoredSigningKey> {
    return this.ensureKey();
  }

  /** Publishes active and retired keys so tokens issued before a rotation stay verifiable. */
  async jwks(): Promise<JwksDocument> {
    await this.ensureKey();
    const keys = await this.loadKeys();
    const now = this.now();
    // The published set changes with time (a retired key drops out of the JWKS when its
    // tokens can no longer be valid), so the filtered document is rebuilt from the cached
    // key list. The expensive part — importing the public keys for verification — is cached
    // separately and only rebuilt when the set of published kids changes.
    return {
      keys: keys
        .filter((key) => this.isPublished(key, now))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(toPublicJwk),
    };
  }

  /** Returns a local verification key set for exactly these published keys. */
  private localFor(document: JwksDocument): LocalJwkSet {
    const signature = document.keys.map((key) => key.kid).join(',');
    if (this.localCache === null || this.localCache.signature !== signature) {
      this.localCache = { signature, local: createLocalJWKSet(document) };
    }
    return this.localCache.local;
  }

  /** Public metadata and rotation health for operators (`GET /api/v1/keys`). */
  async inspect(): Promise<SigningKeyHealth> {
    await this.ensureKey();
    const keys = await this.loadKeys();
    const now = this.now();
    const active = keys.find((key) => key.status === 'active') ?? null;
    const ageDays =
      active === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - active.createdAt.getTime()) / 86_400_000));
    const rotationDue =
      active !== null &&
      this.rotationDueAfterDays > 0 &&
      now.getTime() - active.createdAt.getTime() >= this.rotationDueAfterDays * 86_400_000;

    if (rotationDue) {
      this.onWarning?.(
        `active signing key ${active.kid} is ${ageDays} days old; rotation is due ` +
          `(threshold ${this.rotationDueAfterDays} days)`,
      );
    }

    return {
      keys: keys
        .slice()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((key) => ({
          kid: key.kid,
          alg: key.alg,
          status: key.status,
          createdAt: key.createdAt,
          retiredAt: key.retiredAt ?? null,
          publishedInJwks: this.isPublished(key, now),
        })),
      activeKey:
        active === null || ageDays === null
          ? null
          : { kid: active.kid, createdAt: active.createdAt, ageDays },
      rotationDue,
      rotationDueAfterDays: this.rotationDueAfterDays,
    };
  }

  /**
   * Rotates the signing key: the current active key becomes `retired` (kept in JWKS until
   * its tokens expire) and a new active key is created. With `revokePrevious` the old key
   * is revoked instead, for emergency rotation after a suspected compromise.
   */
  async rotate(options: { revokePrevious?: boolean } = {}): Promise<KeyRotationResult> {
    await this.ensureKey();
    const now = this.now();
    const keys = await this.loadKeys();
    const previous = keys.filter((key) => key.status === 'active');
    const revokePrevious = options.revokePrevious === true;
    for (const key of previous) {
      await this.repository.updateStatus(key.kid, revokePrevious ? 'revoked' : 'retired', now);
    }
    const created = await generateSigningKey('active', now);
    await this.repository.save(created);
    this.invalidate();
    return {
      active: created,
      previousKid: previous[0]?.kid ?? null,
      previousRevoked: revokePrevious,
    };
  }

  /**
   * Revokes one key. A revoked key is removed from the JWKS immediately, so tokens it
   * signed stop verifying. Revoking the active key also provisions a fresh active key.
   */
  async revoke(kid: string): Promise<boolean> {
    await this.ensureKey();
    const keys = await this.loadKeys();
    const target = keys.find((key) => key.kid === kid);
    if (target === undefined) {
      return false;
    }
    await this.repository.updateStatus(kid, 'revoked', this.now());
    // Invalidate before provisioning a replacement, otherwise the cached active key would
    // be the revoked one and `ensureKey` would hand it out again.
    this.invalidate();
    if (target.status === 'active') {
      await this.ensureKey();
    }
    return true;
  }

  async signAccessToken(
    claims: Record<string, unknown>,
    options: SignedTokenOptions,
  ): Promise<string> {
    const key = await this.activeKey();
    const privateKey = await importJWK(key.privateJwk, SIGNING_ALG);
    const issuedAt = options.issuedAt ?? Math.floor(this.now().getTime() / 1000);

    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: SIGNING_ALG, kid: key.kid, typ: 'JWT' })
      .setIssuer(options.issuer)
      .setAudience(options.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + options.expiresInSeconds);

    if (options.subject !== undefined) {
      jwt.setSubject(options.subject);
    }
    return jwt.sign(privateKey);
  }

  /**
   * Verifies a token against the published JWKS. Only ES256 is accepted, so `alg: none`
   * and symmetric algorithms are rejected before any signature check. Revoked keys are
   * not published, and a token that names one fails with an explicit error.
   */
  async verify(token: string, options: VerifyOptions): Promise<JWTVerifyResult['payload']> {
    const document = await this.jwks();
    const local = this.localFor(document);
    try {
      const result = await jwtVerify(token, local, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: [SIGNING_ALG],
        typ: 'JWT',
        ...(options.currentDate === undefined ? {} : { currentDate: options.currentDate }),
      });
      return result.payload;
    } catch (error) {
      // Revoked keys are not published, so the failure is normally "no matching key".
      // Name the real cause when the token explicitly references a revoked key.
      const kid = readKid(token);
      if (kid !== null) {
        const keys = await this.loadKeys();
        if (keys.some((key) => key.kid === kid && key.status === 'revoked')) {
          throw new Error('token was signed by a revoked signing key', { cause: error });
        }
      }
      throw error;
    }
  }

  /**
   * Active keys are always published. Retired keys stay published only while a token they
   * signed can still be valid (`retiredAt + longest token lifetime`). Revoked keys are
   * never published.
   */
  private isPublished(key: StoredSigningKey, now: Date): boolean {
    if (key.status === 'active') {
      return true;
    }
    if (key.status === 'revoked') {
      return false;
    }
    const retiredAt = key.retiredAt ?? key.createdAt;
    return now.getTime() - retiredAt.getTime() < this.retiredRetentionMs;
  }
}

/** Reads the unverified JOSE header `kid`; only used to give revoked keys a clear error. */
function readKid(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] === undefined) {
    return null;
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as {
      kid?: unknown;
    };
    return typeof header.kid === 'string' ? header.kid : null;
  } catch {
    return null;
  }
}

function toPublicJwk(key: StoredSigningKey): PublicJwk {
  const { d: _privateExponent, ...rest } = key.publicJwk as JWK & { d?: string };
  void _privateExponent;
  return { ...rest, kid: key.kid, alg: SIGNING_ALG, use: 'sig' } as PublicJwk;
}

/** In-memory repository for tests and local development without a database. */
export class MemorySigningKeyRepository implements SigningKeyRepository {
  private readonly keys = new Map<string, StoredSigningKey>();

  async list(): Promise<StoredSigningKey[]> {
    return [...this.keys.values()];
  }

  async save(key: StoredSigningKey): Promise<void> {
    this.keys.set(key.kid, key);
  }

  async updateStatus(
    kid: string,
    status: StoredSigningKey['status'],
    retiredAt?: Date,
  ): Promise<void> {
    const existing = this.keys.get(kid);
    if (existing !== undefined) {
      this.keys.set(kid, {
        ...existing,
        status,
        retiredAt: retiredAt ?? existing.retiredAt ?? null,
      });
    }
  }
}

export type { JWK };
