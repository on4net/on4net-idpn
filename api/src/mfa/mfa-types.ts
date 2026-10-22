import type { AuditEventInput } from '../audit/sanitize.js';
import type { Argon2Params } from '../auth/password.js';
import type { SecretBox } from '../crypto/secret-box.js';
import type { MfaChallengeStore } from './challenge-store.js';

/** ACR/AMR values proving a multi-factor session (docs/auth-flows.md 7.3). */
export const MFA_ACR = 'urn:on4net:acr:mfa';
export const MFA_AMR_METHODS = ['totp', 'recovery', 'webauthn', 'hwk'] as const;

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
  /** WebAuthn credential id (raw bytes); `null` for TOTP. */
  credentialId: Buffer | null;
  /** COSE public key of a WebAuthn credential; `null` for TOTP. */
  publicKey: Buffer | null;
  /** Authenticator sign counter, used to detect a cloned authenticator. */
  signCount: bigint;
  transports: string[];
  aaguid: string | null;
  deviceType: string | null;
  backedUp: boolean;
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
  /** Shared lockout state, so a wrong second factor counts like a wrong password. */
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export interface RecoveryCodeRecord {
  id: string;
  codeHash: string;
}

export type CreateTotpFactorResult =
  { ok: true; factor: MfaFactorRecord } | { ok: false; reason: 'already_enrolled' };

/** A WebAuthn credential to persist after a verified registration ceremony. */
export interface NewWebauthnCredential {
  name: string;
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  signCount: bigint;
  transports: readonly string[];
  aaguid: string | null;
  deviceType: string | null;
  backedUp: boolean;
}

export type CreateWebauthnCredentialResult =
  { ok: true; factor: MfaFactorRecord } | { ok: false; reason: 'duplicate_credential' };

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
  listConfirmedWebauthn(userId: string): Promise<MfaFactorRecord[]>;
  findWebauthn(userId: string, factorId: string): Promise<MfaFactorRecord | null>;
  /** Looks a credential up by its raw credential id, scoped to the owning user. */
  findWebauthnByCredentialId(
    userId: string,
    credentialId: Uint8Array,
  ): Promise<MfaFactorRecord | null>;
  /**
   * Persists a new unconfirmed TOTP factor. A pending enrollment of the same user is
   * replaced; an existing confirmed factor makes this fail without touching it.
   */
  createTotpFactor(
    userId: string,
    name: string,
    secretEncrypted: Uint8Array,
  ): Promise<CreateTotpFactorResult>;
  /** Registers a verified passkey. The credential id is unique across all users. */
  createWebauthnCredential(
    userId: string,
    credential: NewWebauthnCredential,
    at: Date,
  ): Promise<CreateWebauthnCredentialResult>;
  confirmFactor(factorId: string, userId: string, at: Date): Promise<boolean>;
  /** Compare-and-set on `lastUsedStep`; `false` means the step was already used (replay). */
  markTotpUsed(factorId: string, step: bigint, at: Date): Promise<boolean>;
  /**
   * Compare-and-set on the sign counter: only the request that observed `expectedCounter`
   * may advance it. `false` means a concurrent/replayed assertion lost the race.
   */
  updateWebauthnCounter(
    factorId: string,
    userId: string,
    expectedCounter: bigint,
    newCounter: bigint,
    at: Date,
  ): Promise<boolean>;
  renameFactor(factorId: string, userId: string, name: string): Promise<boolean>;
  deleteFactor(factorId: string, userId: string): Promise<boolean>;
  /** Replaces every recovery code of the factor, invalidating the previous set atomically. */
  replaceRecoveryCodes(factorId: string, codeHashes: readonly string[], at: Date): Promise<void>;
  listUnusedRecoveryCodes(factorId: string): Promise<RecoveryCodeRecord[]>;
  /** Single-use consumption: `false` when the code was already used. */
  consumeRecoveryCode(codeId: string, at: Date): Promise<boolean>;
  countUnusedRecoveryCodes(factorId: string): Promise<number>;
  findUserSecurity(userId: string): Promise<MfaUserSecurity | null>;
  recordAudit(event: AuditEventInput): Promise<void>;
  /** Effective MFA policy of the session's client/context; `optional` when unbound. */
  resolveMfaPolicy?(input: {
    clientId?: string | undefined;
    loginContext?: string | undefined;
  }): Promise<MfaPolicy>;
  /** Counts an account-level credential failure so the shared lockout also covers MFA. */
  registerFailedAttempt?(userId: string, attempts: number, lockedUntil: Date | null): Promise<void>;
}

/** The subset the login flow needs (policy, challenge verification, auditing). */
export interface MfaLoginRepository {
  /** Policy of the login context, falling back to the client; `optional` without a client. */
  resolveMfaPolicy(input: {
    clientId?: string | undefined;
    loginContext?: string | undefined;
  }): Promise<MfaPolicy>;
  /**
   * Whether the selected login context requires step-up (`docs/login-contexts.md` 7.2).
   * A step-up context never issues a session without a fresh second factor.
   */
  resolveStepUpRequired(input: {
    clientId?: string | undefined;
    loginContext?: string | undefined;
  }): Promise<boolean>;
  findConfirmedTotp(userId: string): Promise<MfaFactorRecord | null>;
  listConfirmedWebauthn(userId: string): Promise<MfaFactorRecord[]>;
  findWebauthnByCredentialId(
    userId: string,
    credentialId: Uint8Array,
  ): Promise<MfaFactorRecord | null>;
  updateWebauthnCounter(
    factorId: string,
    userId: string,
    expectedCounter: bigint,
    newCounter: bigint,
    at: Date,
  ): Promise<boolean>;
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
