import type { SecretBox } from '../crypto/secret-box.js';
import {
  DEFAULT_ARGON2_PARAMS,
  hashPassword,
  verifyPassword,
  type Argon2Params,
} from '../auth/password.js';
import { generateRecoveryCodes, RECOVERY_CODE_COUNT } from '../mfa/recovery-codes.js';
import { buildOtpauthUri, generateTotpSecret } from '../mfa/totp.js';
import { verifyTotpFactor } from '../mfa/verify.js';
import type { MfaFactorRecord, MfaFactorRepository } from '../mfa/mfa-types.js';

/**
 * Account-level MFA workflow (docs/auth-flows.md 7.2, docs/account-api.md).
 *
 * The TOTP secret is returned exactly once, at enrollment; every later response only
 * describes the factor. Recovery codes are generated after a successful enrollment check
 * and are returned once as plaintext, stored as Argon2id hashes.
 */

export interface AccountMfaDependencies {
  repository: MfaFactorRepository;
  /** AES-256-GCM box for TOTP secrets; `null` when the deployment has no key (503). */
  secretBox: SecretBox | null;
  /** Issuer label shown in authenticator apps, e.g. the IdP host. */
  issuer: string;
  now?: () => Date;
  /** Argon2id parameters for recovery code hashes. */
  recoveryParams?: Argon2Params;
  hash?: (value: string, params: Argon2Params) => Promise<string>;
  verify?: (hash: string, value: string, params: Argon2Params) => Promise<boolean>;
}

export interface PublicMfaFactor {
  id: string;
  type: 'totp' | 'webauthn';
  name: string;
  confirmed: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  /** WebAuthn-only: transports reported by the authenticator. */
  transports: string[];
  /** WebAuthn-only: `singleDevice` / `multiDevice`. */
  deviceType: string | null;
  /** WebAuthn-only: the credential is a synced/backed-up passkey. */
  backedUp: boolean;
}

export interface MfaStatus {
  factors: PublicMfaFactor[];
  totp: PublicMfaFactor | null;
  webauthn: PublicMfaFactor[];
  recoveryCodesRemaining: number;
}

const publish = (factor: MfaFactorRecord): PublicMfaFactor => ({
  id: factor.id,
  type: factor.type,
  name: factor.name,
  confirmed: factor.confirmedAt !== null,
  createdAt: factor.createdAt.toISOString(),
  lastUsedAt: factor.lastUsedAt?.toISOString() ?? null,
  transports: [...factor.transports],
  deviceType: factor.deviceType,
  backedUp: factor.backedUp,
});

export async function getMfaStatus(
  deps: AccountMfaDependencies,
  userId: string,
): Promise<MfaStatus> {
  const factors = await deps.repository.listFactors(userId);
  const totp = factors.find((factor) => factor.type === 'totp') ?? null;
  const webauthn = factors.filter(
    (factor) => factor.type === 'webauthn' && factor.confirmedAt !== null,
  );
  const recoveryCodesRemaining =
    totp === null || totp.confirmedAt === null
      ? 0
      : await deps.repository.countUnusedRecoveryCodes(totp.id);
  return {
    factors: factors.map(publish),
    totp: totp === null ? null : publish(totp),
    webauthn: webauthn.map(publish),
    recoveryCodesRemaining,
  };
}

export type EnrollTotpResult =
  | { ok: true; factorId: string; secret: string; otpauthUri: string }
  | { ok: false; reason: 'already_enrolled' | 'unavailable' | 'invalid_password' | 'denied' };

/**
 * Starts TOTP enrolment after re-proving the password. A session alone is not enough: a
 * hijacked session on an account without MFA must not be able to bind an attacker-controlled
 * authenticator and survive a later password reset (docs/security.md, account MFA).
 */
export async function enrollTotp(
  deps: AccountMfaDependencies,
  input: { userId: string; accountName: string; password: string; name?: string },
): Promise<EnrollTotpResult> {
  if (deps.secretBox === null) {
    return { ok: false, reason: 'unavailable' };
  }
  const user = await deps.repository.findUserSecurity(input.userId);
  if (user === null || user.deletedAt !== null || user.status === 'disabled') {
    return { ok: false, reason: 'denied' };
  }
  const params = deps.recoveryParams ?? DEFAULT_ARGON2_PARAMS;
  const proven =
    user.passwordHash !== null &&
    (await (deps.verify ?? verifyPassword)(user.passwordHash, input.password, params));
  if (!proven) {
    await deps.repository.recordAudit({
      actorType: 'user',
      actorId: input.userId,
      action: 'user.mfa.failed',
      targetType: 'user',
      targetId: input.userId,
      result: 'failure',
      metadata: { type: 'totp', stage: 'enroll' },
    });
    return { ok: false, reason: 'invalid_password' };
  }
  const secret = generateTotpSecret();
  const created = await deps.repository.createTotpFactor(
    input.userId,
    input.name ?? 'authenticator',
    deps.secretBox.encrypt(secret),
  );
  if (!created.ok) {
    return { ok: false, reason: created.reason };
  }
  return {
    ok: true,
    factorId: created.factor.id,
    secret,
    otpauthUri: buildOtpauthUri({
      issuer: deps.issuer,
      accountName: input.accountName,
      secret,
    }),
  };
}

export type VerifyEnrollmentResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: 'not_found' | 'already_confirmed' | 'invalid_code' | 'unavailable' };

/** Confirms a pending factor with a valid code and issues a fresh set of recovery codes. */
export async function verifyTotpEnrollment(
  deps: AccountMfaDependencies,
  input: { userId: string; factorId: string; code: string },
): Promise<VerifyEnrollmentResult> {
  const at = (deps.now ?? (() => new Date()))();
  const factor = await deps.repository.findFactor(input.userId, input.factorId);
  if (factor === null || factor.type !== 'totp') {
    return { ok: false, reason: 'not_found' };
  }
  if (factor.confirmedAt !== null) {
    return { ok: false, reason: 'already_confirmed' };
  }
  const proof = await verifyTotpFactor(
    { repository: deps.repository, secretBox: deps.secretBox, consumeStep: false },
    factor,
    input.code,
    at,
  );
  if (!proof.ok) {
    if (proof.reason === 'unavailable') {
      return { ok: false, reason: 'unavailable' };
    }
    await deps.repository.recordAudit({
      actorType: 'user',
      actorId: input.userId,
      action: 'user.mfa.failed',
      targetType: 'mfa_factor',
      targetId: factor.id,
      result: 'failure',
      metadata: { type: 'totp', stage: 'enrollment', reason: proof.reason },
    });
    return { ok: false, reason: 'invalid_code' };
  }

  const confirmed = await deps.repository.confirmFactor(factor.id, input.userId, at);
  if (!confirmed) {
    return { ok: false, reason: 'already_confirmed' };
  }
  const recoveryCodes = await issueRecoveryCodes(deps, factor.id, at);
  await deps.repository.recordAudit({
    actorType: 'user',
    actorId: input.userId,
    action: 'user.mfa.enrolled',
    targetType: 'mfa_factor',
    targetId: factor.id,
    result: 'success',
    metadata: { type: 'totp', recoveryCodes: recoveryCodes.length },
  });
  return { ok: true, recoveryCodes };
}

export type DisableResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'invalid_password' | 'invalid_code' | 'denied' };

/**
 * Removes the TOTP factor after proving ownership with the current password or a valid
 * code. Neither proof is written to the audit log.
 */
export async function disableTotp(
  deps: AccountMfaDependencies,
  input: {
    userId: string;
    factorId?: string;
    password?: string;
    code?: string;
    actorIp?: string | null;
    userAgent?: string | null;
  },
): Promise<DisableResult> {
  const at = (deps.now ?? (() => new Date()))();
  const factor =
    input.factorId === undefined
      ? await deps.repository.findConfirmedTotp(input.userId)
      : await deps.repository.findFactor(input.userId, input.factorId);
  if (factor === null || factor.type !== 'totp' || factor.confirmedAt === null) {
    return { ok: false, reason: 'not_found' };
  }

  const user = await deps.repository.findUserSecurity(input.userId);
  if (user === null || user.deletedAt !== null || user.status === 'disabled') {
    return { ok: false, reason: 'denied' };
  }

  let proven = false;
  if (input.password !== undefined && input.password !== '') {
    const params = deps.recoveryParams ?? DEFAULT_ARGON2_PARAMS;
    proven =
      user.passwordHash !== null &&
      (await (deps.verify ?? verifyPassword)(user.passwordHash, input.password, params));
  }
  if (!proven && input.code !== undefined && input.code !== '') {
    const proof = await verifyTotpFactor(
      { repository: deps.repository, secretBox: deps.secretBox },
      factor,
      input.code,
      at,
    );
    proven = proof.ok;
  }
  if (!proven) {
    await deps.repository.recordAudit({
      actorType: 'user',
      actorId: input.userId,
      action: 'user.mfa.failed',
      targetType: 'mfa_factor',
      targetId: factor.id,
      ip: input.actorIp ?? null,
      userAgent: input.userAgent ?? null,
      result: 'failure',
      metadata: { type: 'totp', stage: 'disable' },
    });
    return {
      ok: false,
      reason: input.password !== undefined ? 'invalid_password' : 'invalid_code',
    };
  }

  await deps.repository.deleteFactor(factor.id, input.userId);
  await deps.repository.recordAudit({
    actorType: 'user',
    actorId: input.userId,
    action: 'user.mfa.removed',
    targetType: 'mfa_factor',
    targetId: factor.id,
    ip: input.actorIp ?? null,
    userAgent: input.userAgent ?? null,
    result: 'success',
    metadata: { type: 'totp', recoveryCodesInvalidated: RECOVERY_CODE_COUNT },
  });
  return { ok: true };
}

export type RegenerateResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: 'not_found' | 'invalid_password' | 'unavailable' };

/** Rotates the recovery codes after a password check; the previous set stops working. */
export async function regenerateRecoveryCodes(
  deps: AccountMfaDependencies,
  input: { userId: string; password: string },
): Promise<RegenerateResult> {
  const at = (deps.now ?? (() => new Date()))();
  const factor = await deps.repository.findConfirmedTotp(input.userId);
  if (factor === null) {
    return { ok: false, reason: 'not_found' };
  }
  const user = await deps.repository.findUserSecurity(input.userId);
  if (user === null || user.passwordHash === null) {
    return { ok: false, reason: 'not_found' };
  }
  const params = deps.recoveryParams ?? DEFAULT_ARGON2_PARAMS;
  const valid = await (deps.verify ?? verifyPassword)(user.passwordHash, input.password, params);
  if (!valid) {
    await deps.repository.recordAudit({
      actorType: 'user',
      actorId: input.userId,
      action: 'user.mfa.failed',
      targetType: 'mfa_factor',
      targetId: factor.id,
      result: 'failure',
      metadata: { type: 'totp', stage: 'recovery_regenerate' },
    });
    return { ok: false, reason: 'invalid_password' };
  }
  const recoveryCodes = await issueRecoveryCodes(deps, factor.id, at);
  await deps.repository.recordAudit({
    actorType: 'user',
    actorId: input.userId,
    action: 'user.mfa.recovery_codes_rotated',
    targetType: 'mfa_factor',
    targetId: factor.id,
    result: 'success',
    metadata: { type: 'totp', count: recoveryCodes.length },
  });
  return { ok: true, recoveryCodes };
}

async function issueRecoveryCodes(
  deps: AccountMfaDependencies,
  factorId: string,
  at: Date,
): Promise<string[]> {
  const params = deps.recoveryParams ?? DEFAULT_ARGON2_PARAMS;
  const hash = deps.hash ?? hashPassword;
  const codes = generateRecoveryCodes();
  const hashes: string[] = [];
  for (const code of codes) {
    // Hash the normalized value (no separator) so entry is separator-insensitive.
    hashes.push(await hash(code.replace(/-/g, ''), params));
  }
  await deps.repository.replaceRecoveryCodes(factorId, hashes, at);
  return codes;
}
