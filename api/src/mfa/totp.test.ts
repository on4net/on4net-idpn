import { describe, expect, it } from 'vitest';

import {
  buildOtpauthUri,
  decodeBase32,
  encodeBase32,
  generateTotpSecret,
  hotp,
  stepAt,
  totpCode,
  verifyTotp,
} from './totp.js';

/** RFC 4226 appendix D: ASCII "12345678901234567890". */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32', () => {
  it('encodes and decodes RFC 4648 vectors without padding', () => {
    expect(encodeBase32(Buffer.from('foobar', 'ascii'))).toBe('MZXW6YTBOI');
    expect(decodeBase32('MZXW6YTBOI======').toString('ascii')).toBe('foobar');
    expect(encodeBase32(Buffer.from('f', 'ascii'))).toBe('MY');
    expect(decodeBase32('my').toString('ascii')).toBe('f');
  });

  it('accepts the lowercase, spaced and padded forms a user may paste', () => {
    expect(decodeBase32('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString('ascii')).toBe(
      '12345678901234567890',
    );
  });

  it('rejects characters and lengths that cannot represent bytes', () => {
    expect(() => decodeBase32('MZXW6YTB0I')).toThrow();
    expect(() => decodeBase32('')).toThrow();
    // 7 characters = 35 bits: a remainder of 3 bits is not a whole byte.
    expect(() => decodeBase32('MZXW6YT')).toThrow();
  });

  it('generates a 160-bit secret as 32 base32 characters', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(decodeBase32(secret)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(secret);
  });
});

describe('HOTP — RFC 4226 appendix D', () => {
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];

  it('matches every published counter value', () => {
    expected.forEach((code, counter) => {
      expect(hotp(RFC_SECRET, BigInt(counter), 6), `counter ${counter}`).toBe(code);
    });
  });
});

describe('TOTP — RFC 6238 appendix B (SHA-1, 8 digits)', () => {
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ];

  it('matches every published time step', () => {
    for (const [seconds, expected] of vectors) {
      expect(hotp(RFC_SECRET, stepAt(seconds * 1000), 8), `t=${seconds}`).toBe(expected);
    }
  });

  it('produces the same code from the base32 secret', () => {
    expect(totpCode(RFC_SECRET_BASE32, 59_000, 8)).toBe('94287082');
  });

  it('uses a 30-second step', () => {
    expect(stepAt(0)).toBe(0n);
    expect(stepAt(29_999)).toBe(0n);
    expect(stepAt(30_000)).toBe(1n);
    expect(stepAt(59_000)).toBe(1n);
  });
});

describe('verifyTotp', () => {
  const secret = RFC_SECRET_BASE32;
  const atMs = 59_000;

  it('accepts the current code and returns the accepted step', () => {
    const result = verifyTotp(secret, totpCode(secret, atMs), { atMs });
    expect(result).toEqual({ ok: true, step: 1n });
  });

  it('accepts ±1 step for clock skew but not ±2', () => {
    const centre = 120_000;
    const previous = totpCode(secret, centre - 30_000);
    const next = totpCode(secret, centre + 30_000);
    const tooOld = totpCode(secret, centre - 60_000);
    const tooNew = totpCode(secret, centre + 60_000);

    expect(verifyTotp(secret, totpCode(secret, centre), { atMs: centre }).ok).toBe(true);
    expect(verifyTotp(secret, previous, { atMs: centre }).ok).toBe(true);
    expect(verifyTotp(secret, next, { atMs: centre }).ok).toBe(true);
    expect(verifyTotp(secret, tooOld, { atMs: centre })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyTotp(secret, tooNew, { atMs: centre })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a code whose step was already used (replay)', () => {
    const code = totpCode(secret, atMs);
    expect(verifyTotp(secret, code, { atMs, lastUsedStep: 1n })).toEqual({
      ok: false,
      reason: 'replayed',
    });
    // A later step is still accepted.
    const next = totpCode(secret, 90_000);
    expect(verifyTotp(secret, next, { atMs: 90_000, lastUsedStep: 1n })).toEqual({
      ok: true,
      step: 3n,
    });
  });

  it('rejects malformed input without throwing', () => {
    expect(verifyTotp(secret, '12345', { atMs })).toEqual({ ok: false, reason: 'invalid_format' });
    expect(verifyTotp(secret, 'abcdef', { atMs })).toEqual({ ok: false, reason: 'invalid_format' });
    expect(verifyTotp(secret, '000000', { atMs })).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('otpauth URI', () => {
  it('describes the TOTP parameters for authenticator apps', () => {
    const uri = buildOtpauthUri({
      issuer: 'auth.example.com',
      accountName: 'sara@example.com',
      secret: RFC_SECRET_BASE32,
    });

    expect(uri.startsWith('otpauth://totp/auth.example.com:sara%40example.com?')).toBe(true);
    const params = new URLSearchParams(uri.split('?')[1]);
    expect(params.get('secret')).toBe(RFC_SECRET_BASE32);
    expect(params.get('issuer')).toBe('auth.example.com');
    expect(params.get('algorithm')).toBe('SHA1');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
  });
});
