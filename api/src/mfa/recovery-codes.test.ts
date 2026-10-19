import { describe, expect, it } from 'vitest';

import {
  RECOVERY_CODE_COUNT,
  formatRecoveryCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
} from './recovery-codes.js';

describe('recovery codes', () => {
  it('generates ten unique codes in the documented format', () => {
    const codes = generateRecoveryCodes();

    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    }
  });

  it('normalizes separators, spaces and case', () => {
    expect(normalizeRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode(' ABCDE FGHJK ')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('ABCDE-FGHJ')).toBeNull();
    expect(normalizeRecoveryCode('ABCDE-FGHJ0')).toBeNull();
    expect(normalizeRecoveryCode('')).toBeNull();
  });

  it('formats a code for one-time display', () => {
    expect(formatRecoveryCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
  });
});
