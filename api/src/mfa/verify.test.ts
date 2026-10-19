import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword, type Argon2Params } from '../auth/password.js';
import { createSecretBox } from '../crypto/secret-box.js';
import type { MfaFactorRecord, RecoveryCodeRecord } from './mfa-types.js';
import { generateRecoveryCodes, normalizeRecoveryCode } from './recovery-codes.js';
import { generateTotpSecret, totpCode } from './totp.js';
import { verifyRecoveryCode, verifyTotpFactor } from './verify.js';

const FAST: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const box = createSecretBox(Buffer.alloc(32, 9));
const at = new Date('2026-10-19T10:00:00.000Z');

function factor(overrides: Partial<MfaFactorRecord> = {}): MfaFactorRecord {
  return {
    id: 'factor-1',
    userId: 'user-1',
    type: 'totp',
    name: 'authenticator',
    secretEncrypted: null,
    credentialId: null,
    publicKey: null,
    signCount: 0n,
    transports: [],
    aaguid: null,
    deviceType: null,
    backedUp: false,
    confirmedAt: null,
    lastUsedAt: null,
    lastUsedStep: null,
    createdAt: at,
    ...overrides,
  };
}

/** Minimal in-memory repository that enforces the same single-use rules as PostgreSQL. */
function totpRepository() {
  const usedSteps: bigint[] = [];
  return {
    usedSteps,
    async markTotpUsed(_factorId: string, step: bigint): Promise<boolean> {
      if (usedSteps.some((used) => used >= step)) {
        return false;
      }
      usedSteps.push(step);
      return true;
    },
  };
}

function recoveryRepository(hashes: string[]) {
  const rows: (RecoveryCodeRecord & { usedAt: Date | null })[] = hashes.map((codeHash, index) => ({
    id: `code-${index}`,
    codeHash,
    usedAt: null,
  }));
  return {
    rows,
    async listUnusedRecoveryCodes(): Promise<RecoveryCodeRecord[]> {
      return rows
        .filter((row) => row.usedAt === null)
        .map(({ id, codeHash }) => ({ id, codeHash }));
    },
    async consumeRecoveryCode(codeId: string): Promise<boolean> {
      const row = rows.find((entry) => entry.id === codeId);
      if (row === undefined || row.usedAt !== null) {
        return false;
      }
      row.usedAt = at;
      return true;
    },
  };
}

describe('verifyTotpFactor', () => {
  it('accepts a valid code once and rejects the replayed step', async () => {
    const secret = generateTotpSecret();
    const repository = totpRepository();
    const stored = factor({ secretEncrypted: box.encrypt(secret) });
    const code = totpCode(secret, at.getTime());

    await expect(
      verifyTotpFactor({ repository, secretBox: box }, stored, code, at),
    ).resolves.toEqual({ ok: true });
    await expect(
      verifyTotpFactor({ repository, secretBox: box }, stored, code, at),
    ).resolves.toEqual({ ok: false, reason: 'replayed' });
    expect(repository.usedSteps).toHaveLength(1);
  });

  it('fails closed when the envelope cannot be decrypted', async () => {
    const repository = totpRepository();
    const otherBox = createSecretBox(Buffer.alloc(32, 3));
    const stored = factor({ secretEncrypted: otherBox.encrypt(generateTotpSecret()) });

    await expect(
      verifyTotpFactor({ repository, secretBox: box }, stored, '123456', at),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(repository.usedSteps).toHaveLength(0);
  });

  it('fails when no encryption key is configured', async () => {
    const repository = totpRepository();
    const stored = factor({ secretEncrypted: box.encrypt(generateTotpSecret()) });

    await expect(
      verifyTotpFactor({ repository, secretBox: null }, stored, '123456', at),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('does not consume the step when the caller is only confirming enrollment', async () => {
    const secret = generateTotpSecret();
    const repository = totpRepository();
    const stored = factor({ secretEncrypted: box.encrypt(secret) });
    const code = totpCode(secret, at.getTime());

    await expect(
      verifyTotpFactor({ repository, secretBox: box, consumeStep: false }, stored, code, at),
    ).resolves.toEqual({ ok: true });
    expect(repository.usedSteps).toHaveLength(0);
    // The same code can still complete the first login.
    await expect(
      verifyTotpFactor({ repository, secretBox: box }, stored, code, at),
    ).resolves.toEqual({ ok: true });
  });

  it('rejects a code for a different secret', async () => {
    const repository = totpRepository();
    const stored = factor({ secretEncrypted: box.encrypt(generateTotpSecret()) });

    await expect(
      verifyTotpFactor(
        { repository, secretBox: box },
        stored,
        totpCode(generateTotpSecret(), at.getTime()),
        at,
      ),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('verifyRecoveryCode', () => {
  it('accepts each hashed code exactly once', async () => {
    const codes = generateRecoveryCodes();
    const hashes: string[] = [];
    for (const code of codes) {
      hashes.push(await hashPassword(normalizeRecoveryCode(code) ?? '', FAST));
    }
    const repository = recoveryRepository(hashes);
    const verify = (hash: string, value: string) => verifyPassword(hash, value, FAST);

    await expect(
      verifyRecoveryCode({ repository, verify, at }, 'factor-1', codes[0] ?? ''),
    ).resolves.toEqual({ ok: true });
    // Replaying the same code fails: it is no longer in the unused set.
    await expect(
      verifyRecoveryCode({ repository, verify, at }, 'factor-1', codes[0] ?? ''),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
    // A different code still works.
    await expect(
      verifyRecoveryCode({ repository, verify, at }, 'factor-1', codes[1] ?? ''),
    ).resolves.toEqual({ ok: true });
    expect(repository.rows.filter((row) => row.usedAt !== null)).toHaveLength(2);
  });

  it('rejects unknown and malformed codes', async () => {
    const hashes = [await hashPassword('ABCDEFGHJK', FAST)];
    const repository = recoveryRepository(hashes);
    const verify = (hash: string, value: string) => verifyPassword(hash, value, FAST);

    await expect(
      verifyRecoveryCode({ repository, verify, at }, 'factor-1', 'ZZZZZ-ZZZZZ'),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(
      verifyRecoveryCode({ repository, verify, at }, 'factor-1', 'too-short'),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
  });
});
