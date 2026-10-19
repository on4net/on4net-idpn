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
