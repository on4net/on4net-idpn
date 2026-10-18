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
  PublicJwk,
  SignedTokenOptions,
  SigningKeyRepository,
  StoredSigningKey,
  VerifyOptions,
} from './key-types.js';

export const SIGNING_ALG = 'ES256' as const;

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
  constructor(
    private readonly repository: SigningKeyRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Creates and persists a first active key when the store is empty. */
  async ensureKey(): Promise<StoredSigningKey> {
    const keys = await this.repository.list();
    const active = keys.find((key) => key.status === 'active');
    if (active !== undefined) {
      return active;
    }
    const created = await generateSigningKey('active', this.now());
    await this.repository.save(created);
    return created;
  }

  async activeKey(): Promise<StoredSigningKey> {
    return this.ensureKey();
  }

  /** Publishes active and retired keys so tokens issued before a rotation stay verifiable. */
  async jwks(): Promise<JwksDocument> {
    await this.ensureKey();
    const keys = await this.repository.list();
    return {
      keys: keys
        .filter((key) => key.status !== 'revoked')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(toPublicJwk),
    };
  }

  /**
   * Rotates the signing key: the current active key becomes `retired` (kept in JWKS until
   * its tokens expire) and a new active key is created.
   */
  async rotate(): Promise<StoredSigningKey> {
    await this.ensureKey();
    const keys = await this.repository.list();
    for (const key of keys.filter((entry) => entry.status === 'active')) {
      await this.repository.updateStatus(key.kid, 'retired', this.now());
    }
    const created = await generateSigningKey('active', this.now());
    await this.repository.save(created);
    return created;
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
   * and symmetric algorithms are rejected before any signature check.
   */
  async verify(token: string, options: VerifyOptions): Promise<JWTVerifyResult['payload']> {
    const jwks = await this.jwks();
    const result = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: options.issuer,
      audience: options.audience,
      algorithms: [SIGNING_ALG],
      typ: 'JWT',
    });
    return result.payload;
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
