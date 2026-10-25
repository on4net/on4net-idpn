import type { SecretBox } from '../crypto/secret-box.js';
import { verifyTotp } from './totp.js';
import { normalizeRecoveryCode } from './recovery-codes.js';
import type { MfaFactorRecord, RecoveryCodeRecord } from './mfa-types.js';
import type { RecoveryLookup } from './recovery-lookup.js';

export type MfaProofFailure = 'invalid' | 'replayed' | 'unavailable';

export type MfaProof = { ok: true } | { ok: false; reason: MfaProofFailure };

export interface RecoveryCodeSource {
  listUnusedRecoveryCodes(factorId: string): Promise<RecoveryCodeRecord[]>;
  consumeRecoveryCode(codeId: string, at: Date): Promise<boolean>;
  findUnusedRecoveryCodeByLookup?(
    factorId: string,
    lookups: readonly string[],
  ): Promise<RecoveryCodeRecord | null>;
  listUnusedLegacyRecoveryCodes?(factorId: string): Promise<RecoveryCodeRecord[]>;
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
 * Checks a recovery code and consumes it atomically, so the code is single-use.
 *
 * With a lookup (card #79) the server-keyed HMAC of the code selects the one candidate row,
 * and exactly one Argon2id verification runs per attempt: against that row, or against a decoy
 * when nothing matched, so a wrong guess costs the same as a right one. Rows written before
 * the lookup column existed (`code_lookup IS NULL`) are still checked by the bounded legacy
 * scan until their next rotation. Without a lookup the original scan over every unused hash
 * is kept (tests and deployments that have not configured one).
 */
export async function verifyRecoveryCode(
  options: {
    repository: RecoveryCodeSource;
    verify: (hash: string, value: string) => Promise<boolean>;
    at: Date;
    lookup?: RecoveryLookup;
    /** Hash verified when no row matched, so a miss is not cheaper than a hit. */
    decoyHash?: () => Promise<string>;
  },
  factorId: string,
  input: string,
): Promise<MfaProof> {
  const normalized = normalizeRecoveryCode(input);
  if (normalized === null) {
    return { ok: false, reason: 'invalid' };
  }

  const consume = async (candidate: RecoveryCodeRecord): Promise<MfaProof> => {
    const consumed = await options.repository.consumeRecoveryCode(candidate.id, options.at);
    if (!consumed) {
      return { ok: false, reason: 'replayed' };
    }
    return { ok: true };
  };

  if (options.lookup !== undefined && options.repository.findUnusedRecoveryCodeByLookup) {
    const candidate = await options.repository.findUnusedRecoveryCodeByLookup(
      factorId,
      options.lookup.candidates(normalized),
    );
    if (candidate !== null) {
      return (await options.verify(candidate.codeHash, normalized))
        ? consume(candidate)
        : { ok: false, reason: 'invalid' };
    }
    const legacy = options.repository.listUnusedLegacyRecoveryCodes
      ? await options.repository.listUnusedLegacyRecoveryCodes(factorId)
      : [];
    for (const row of legacy) {
      if (await options.verify(row.codeHash, normalized)) {
        return consume(row);
      }
    }
    if (legacy.length === 0 && options.decoyHash !== undefined) {
      await options.verify(await options.decoyHash(), normalized);
    }
    return { ok: false, reason: 'invalid' };
  }

  const unused = await options.repository.listUnusedRecoveryCodes(factorId);
  for (const candidate of unused) {
    if (!(await options.verify(candidate.codeHash, normalized))) {
      continue;
    }
    return consume(candidate);
  }
  return { ok: false, reason: 'invalid' };
}
