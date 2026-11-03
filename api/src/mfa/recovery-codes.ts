import { randomBytes } from 'node:crypto';

/**
 * One-time recovery codes (docs/auth-flows.md 7.5).
 *
 * Ten codes per factor, ten characters from a 32-symbol alphabet that omits visually
 * ambiguous characters. The plaintext is shown once; only the Argon2id hash is stored and
 * each code is consumed with a conditional update, so a code can never be used twice.
 */

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_LENGTH = 10;
const NORMALIZED_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;

/** `ABCDE-FGHJK` form used for display and for user entry. */
export function formatRecoveryCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * Normalizes user input: uppercase, separators and whitespace removed. Returns `null` for
 * anything that cannot be a recovery code, so the caller answers with a generic failure.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const normalized = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return NORMALIZED_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Generates `count` unique formatted codes. 32 divides 256 evenly, so `byte % 32` has no
 * modulo bias.
 */
export function generateRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT,
  random: (size: number) => Buffer = randomBytes,
): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const bytes = random(RECOVERY_LENGTH);
    let code = '';
    for (const byte of bytes.subarray(0, RECOVERY_LENGTH)) {
      code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    }
    codes.add(formatRecoveryCode(code));
  }
  return [...codes];
}
