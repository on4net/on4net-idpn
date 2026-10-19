import type { SecretBox } from '../crypto/secret-box.js';
import { verifyTotp } from './totp.js';
import { normalizeRecoveryCode } from './recovery-codes.js';
import type { MfaFactorRecord, RecoveryCodeRecord } from './mfa-types.js';

export type MfaProofFailure = 'invalid' | 'replayed' | 'unavailable';

export type MfaProof = { ok: true } | { ok: false; reason: MfaProofFailure };

export interface RecoveryCodeSource {
  listUnusedRecoveryCodes(factorId: string): Promise<RecoveryCodeRecord[]>;
  consumeRecoveryCode(codeId: string, at: Date): Promise<boolean>;
}

/**
 * Checks a TOTP code against the decrypted factor secret and consumes its step.
 *
 * The step is recorded with a compare-and-set, so two requests carrying the same valid code
 * cannot both succeed: the loser is reported as a replay and gets no session.
 */
export async function verifyTotpFactor(
  options: {
    repository: {
      markTotpUsed(factorId: string, step: bigint, at: Date): Promise<boolean>;
    };
    secretBox: SecretBox | null;
    /**
     * Persist the accepted step (default). Enrollment verification disables this: confirming
     * a new factor must not consume the current step, otherwise the user cannot sign in
     * until the next 30-second window.
     */
    consumeStep?: boolean;
  },
  factor: MfaFactorRecord,
  code: string,
  at: Date,
): Promise<MfaProof> {
  if (factor.secretEncrypted === null || options.secretBox === null) {
    return { ok: false, reason: 'unavailable' };
  }
  let secret: string;
  try {
    secret = options.secretBox.decrypt(factor.secretEncrypted);
  } catch {
    // A rotated or corrupt key must fail closed, never bypass the second factor.
    return { ok: false, reason: 'unavailable' };
  }
  const verification = verifyTotp(secret, code, {
    atMs: at.getTime(),
    lastUsedStep: factor.lastUsedStep,
  });
  if (!verification.ok) {
    return { ok: false, reason: verification.reason === 'replayed' ? 'replayed' : 'invalid' };
  }
  if (options.consumeStep === false) {
    return { ok: true };
  }
  const consumed = await options.repository.markTotpUsed(factor.id, verification.step, at);
  return consumed ? { ok: true } : { ok: false, reason: 'replayed' };
}

/**
 * Checks a recovery code. Every unused hash is verified with Argon2id (never compared as
 * plaintext) and the match is consumed atomically, so the code is single-use.
 */
export async function verifyRecoveryCode(
  options: {
    repository: RecoveryCodeSource;
    verify: (hash: string, value: string) => Promise<boolean>;
    at: Date;
  },
  factorId: string,
  input: string,
): Promise<MfaProof> {
  const normalized = normalizeRecoveryCode(input);
  if (normalized === null) {
    return { ok: false, reason: 'invalid' };
  }
  const unused = await options.repository.listUnusedRecoveryCodes(factorId);
  for (const candidate of unused) {
    if (!(await options.verify(candidate.codeHash, normalized))) {
      continue;
    }
    const consumed = await options.repository.consumeRecoveryCode(candidate.id, options.at);
    return consumed ? { ok: true } : { ok: false, reason: 'replayed' };
  }
  return { ok: false, reason: 'invalid' };
}
