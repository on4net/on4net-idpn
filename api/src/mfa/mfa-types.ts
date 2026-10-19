import type { AuditEventInput } from '../audit/sanitize.js';
import type { Argon2Params } from '../auth/password.js';
import type { SecretBox } from '../crypto/secret-box.js';
import type { MfaChallengeStore } from './challenge-store.js';

/** ACR/AMR values proving a multi-factor session (docs/auth-flows.md 7.3). */
export const MFA_ACR = 'urn:on4net:acr:mfa';
export const MFA_AMR_METHODS = ['totp', 'recovery', 'webauthn'] as const;

/** MFA policy of a client or login context (docs/domain-model.md 2.6, docs/login-contexts.md 3.1). */
export type MfaPolicy = 'optional' | 'required_admins' | 'required_all';

export type MfaFactorType = 'totp' | 'webauthn';

/** A stored factor. `secretEncrypted` is an AES-256-GCM envelope and never leaves the server. */
export interface MfaFactorRecord {
  id: string;
  userId: string;
  type: MfaFactorType;
  name: string;
  secretEncrypted: Buffer | null;
  confirmedAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedStep: bigint | null;
  createdAt: Date;
}

/** Fields needed to re-check the password for a sensitive MFA operation. */
export interface MfaUserSecurity {
  id: string;
  tenantId: string;
  username: string;
  email: string;
  status: 'active' | 'locked' | 'disabled' | 'pending';
  passwordHash: string | null;
  deletedAt: Date | null;
}

export interface RecoveryCodeRecord {
  id: string;
  codeHash: string;
}

export type CreateTotpFactorResult =
  { ok: true; factor: MfaFactorRecord } | { ok: false; reason: 'already_enrolled' };

/**
 * Persistence port for the account surface. Every method is scoped to a `userId` so one
 * signed-in user can never read or mutate another user's factors.
 */
export interface MfaFactorRepository {
  listFactors(userId: string): Promise<MfaFactorRecord[]>;
  /** The single TOTP factor of a user, confirmed or still pending enrollment. */
  findTotp(userId: string): Promise<MfaFactorRecord | null>;
  findConfirmedTotp(userId: string): Promise<MfaFactorRecord | null>;
  findFactor(userId: string, factorId: string): Promise<MfaFactorRecord | null>;
  /**
   * Persists a new unconfirmed TOTP factor. A pending enrollment of the same user is
   * replaced; an existing confirmed factor makes this fail without touching it.
   */
  createTotpFactor(
    userId: string,
    name: string,
    secretEncrypted: Uint8Array,
  ): Promise<CreateTotpFactorResult>;
  confirmFactor(factorId: string, userId: string, at: Date): Promise<boolean>;
  /** Compare-and-set on `lastUsedStep`; `false` means the step was already used (replay). */
  markTotpUsed(factorId: string, step: bigint, at: Date): Promise<boolean>;
  deleteFactor(factorId: string, userId: string): Promise<boolean>;
  /** Replaces every recovery code of the factor, invalidating the previous set atomically. */
  replaceRecoveryCodes(factorId: string, codeHashes: readonly string[], at: Date): Promise<void>;
  listUnusedRecoveryCodes(factorId: string): Promise<RecoveryCodeRecord[]>;
  /** Single-use consumption: `false` when the code was already used. */
  consumeRecoveryCode(codeId: string, at: Date): Promise<boolean>;
  countUnusedRecoveryCodes(factorId: string): Promise<number>;
  findUserSecurity(userId: string): Promise<MfaUserSecurity | null>;
  recordAudit(event: AuditEventInput): Promise<void>;
}

/** The subset the login flow needs (policy, challenge verification, auditing). */
export interface MfaLoginRepository {
  /** Policy of the login context, falling back to the client; `optional` without a client. */
  resolveMfaPolicy(input: {
    clientId?: string | undefined;
    loginContext?: string | undefined;
  }): Promise<MfaPolicy>;
  findConfirmedTotp(userId: string): Promise<MfaFactorRecord | null>;
  findUserSecurity(userId: string): Promise<MfaUserSecurity | null>;
  markTotpUsed(factorId: string, step: bigint, at: Date): Promise<boolean>;
  listUnusedRecoveryCodes(factorId: string): Promise<RecoveryCodeRecord[]>;
  consumeRecoveryCode(codeId: string, at: Date): Promise<boolean>;
  recordAudit(event: AuditEventInput): Promise<void>;
  /** Whether the account counts as an administrator for `required_admins`. */
  isAdmin(userId: string, clientId?: string): Promise<boolean>;
}

/** Everything the login and challenge endpoints need to verify a second factor. */
export interface MfaLoginDependencies {
  repository: MfaLoginRepository;
  challenges: MfaChallengeStore;
  /** AES-256-GCM box for TOTP secrets; `null` when the deployment has no key. */
  secretBox: SecretBox | null;
  /** Argon2id verifier for recovery-code hashes. */
  verify: (hash: string, value: string, params: Argon2Params) => Promise<boolean>;
  recoveryParams?: Argon2Params;
}
