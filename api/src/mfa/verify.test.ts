import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword, type Argon2Params } from '../auth/password.js';
import { createSecretBox } from '../crypto/secret-box.js';
import type { MfaFactorRecord, RecoveryCodeRecord } from './mfa-types.js';
import { generateRecoveryCodes, normalizeRecoveryCode } from './recovery-codes.js';
import { createRecoveryLookup } from './recovery-lookup.js';
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

describe('verifyRecoveryCode with a keyed lookup (card #79)', () => {
  const lookup = createRecoveryLookup({
    current: { id: 'k2', value: Buffer.from('unit-test-recovery-lookup-key-two-0123456789') },
    previous: [{ id: 'k1', value: Buffer.from('unit-test-recovery-lookup-key-one-0123456789') }],
  });
  const oldLookup = createRecoveryLookup({
    current: { id: 'k1', value: Buffer.from('unit-test-recovery-lookup-key-one-0123456789') },
    previous: [],
  });

  interface Row extends RecoveryCodeRecord {
    usedAt: Date | null;
  }

  async function build(
    codes: readonly string[],
    options: { lookupFor?: (normalized: string) => string | null } = {},
  ) {
    const rows: Row[] = [];
    for (const [index, code] of codes.entries()) {
      const normalized = normalizeRecoveryCode(code) ?? '';
      rows.push({
        id: `code-${String(index)}`,
        codeHash: await hashPassword(normalized, FAST),
        codeLookup:
          options.lookupFor === undefined
            ? lookup.create(normalized)
            : options.lookupFor(normalized),
        usedAt: null,
      });
    }
    const repository = {
      rows,
      async listUnusedRecoveryCodes() {
        return rows.filter((row) => row.usedAt === null);
      },
      async findUnusedRecoveryCodeByLookup(_factorId: string, lookups: readonly string[]) {
        return (
          rows.find(
            (row) =>
              row.usedAt === null &&
              row.codeLookup !== null &&
              lookups.includes(row.codeLookup ?? ''),
          ) ?? null
        );
      },
      async listUnusedLegacyRecoveryCodes() {
        return rows.filter((row) => row.usedAt === null && row.codeLookup === null);
      },
      async consumeRecoveryCode(codeId: string, when: Date) {
        const row = rows.find((entry) => entry.id === codeId);
        if (row === undefined || row.usedAt !== null) {
          return false;
        }
        row.usedAt = when;
        return true;
      },
    };
    const verifications: string[] = [];
    const verify = async (hash: string, value: string) => {
      verifications.push(hash);
      return verifyPassword(hash, value, FAST);
    };
    const decoy = await hashPassword('decoy-value', FAST);
    return { repository, verify, verifications, decoyHash: async () => decoy };
  }

  it('runs exactly one Argon2id verification for a correct code among ten', async () => {
    const codes = generateRecoveryCodes();
    const { repository, verify, verifications, decoyHash } = await build(codes);

    await expect(
      verifyRecoveryCode({ repository, verify, at, lookup, decoyHash }, 'factor-1', codes[7] ?? ''),
    ).resolves.toEqual({ ok: true });

    expect(verifications).toHaveLength(1);
    expect(repository.rows.filter((row) => row.usedAt !== null)).toHaveLength(1);
  });

  it('costs a wrong code exactly one verification too, not one per stored code', async () => {
    const codes = generateRecoveryCodes();
    const { repository, verify, verifications, decoyHash } = await build(codes);

    await expect(
      verifyRecoveryCode({ repository, verify, at, lookup, decoyHash }, 'factor-1', 'ZZZZZ-ZZZZZ'),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });

    expect(verifications).toHaveLength(1);
    expect(repository.rows.every((row) => row.usedAt === null)).toBe(true);
  });

  it('refuses a spent code without a second use and still costs one verification', async () => {
    const codes = generateRecoveryCodes();
    const { repository, verify, verifications, decoyHash } = await build(codes);
    const attempt = () =>
      verifyRecoveryCode({ repository, verify, at, lookup, decoyHash }, 'factor-1', codes[0] ?? '');

    await expect(attempt()).resolves.toEqual({ ok: true });
    await expect(attempt()).resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(verifications).toHaveLength(2);
  });

  it('finds a row written under a previous key', async () => {
    const codes = generateRecoveryCodes(3);
    const { repository, verify, verifications, decoyHash } = await build(codes, {
      lookupFor: (normalized) => oldLookup.create(normalized),
    });

    await expect(
      verifyRecoveryCode({ repository, verify, at, lookup, decoyHash }, 'factor-1', codes[1] ?? ''),
    ).resolves.toEqual({ ok: true });
    expect(verifications).toHaveLength(1);
  });

  it('keeps pre-lookup rows working through the bounded legacy scan', async () => {
    const codes = generateRecoveryCodes(4);
    const { repository, verify, verifications, decoyHash } = await build(codes, {
      lookupFor: () => null,
    });

    await expect(
      verifyRecoveryCode({ repository, verify, at, lookup, decoyHash }, 'factor-1', codes[2] ?? ''),
    ).resolves.toEqual({ ok: true });
    // The scan stops at the match: at most the number of legacy rows, never more.
    expect(verifications.length).toBeLessThanOrEqual(4);
    expect(verifications.length).toBeGreaterThanOrEqual(1);
  });

  it('does not accept a row whose lookup belongs to another code', async () => {
    const codes = generateRecoveryCodes(2);
    const { repository, verify, decoyHash } = await build(codes);
    // Corrupt: row 0 keeps code 0's lookup but carries code 1's hash.
    repository.rows[0]!.codeHash = repository.rows[1]!.codeHash;

    await expect(
      verifyRecoveryCode({ repository, verify, at, lookup, decoyHash }, 'factor-1', codes[0] ?? ''),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(repository.rows[0]!.usedAt).toBeNull();
  });
});
