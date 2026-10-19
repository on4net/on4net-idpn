import { describe, expect, it } from 'vitest';

import {
  createSecretBox,
  loadMfaSecretKey,
  loadSocialSecretKey,
  parseSecretKey,
  SecretBoxError,
  SOCIAL_SECRET_KEY_ENV,
} from './secret-box.js';

const keyA = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const keyB = 'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=';

describe('createSecretBox', () => {
  it('roundtrips a provider secret', () => {
    const box = createSecretBox(keyA);
    const secret = 'GOCSPX-very-secret-value-🔐';

    const envelope = box.encrypt(secret);

    expect(envelope).toBeInstanceOf(Buffer);
    expect(box.decrypt(envelope)).toBe(secret);
  });

  it('uses a fresh random IV and ciphertext for every encryption', () => {
    const box = createSecretBox(keyA);
    const first = box.encrypt('same-secret');
    const second = box.encrypt('same-secret');

    expect(first.equals(second)).toBe(false);
    // Layout: version(1) | iv(12) | tag(16) | ciphertext.
    expect(first.subarray(1, 13).equals(second.subarray(1, 13))).toBe(false);
    expect(first.subarray(13, 29).equals(second.subarray(13, 29))).toBe(false);
    expect(first.subarray(29).equals(second.subarray(29))).toBe(false);
    expect(box.decrypt(first)).toBe('same-secret');
    expect(box.decrypt(second)).toBe('same-secret');
  });

  it('detects tampering with the ciphertext, tag or IV', () => {
    const box = createSecretBox(keyA);
    const envelope = box.encrypt('GOCSPX-secret');

    const ciphertext = Buffer.from(envelope);
    const last = ciphertext.length - 1;
    ciphertext.writeUInt8(ciphertext.readUInt8(last) ^ 0xff, last);
    expect(() => box.decrypt(ciphertext)).toThrow(SecretBoxError);

    const tag = Buffer.from(envelope);
    tag.writeUInt8(tag.readUInt8(20) ^ 0x01, 20);
    expect(() => box.decrypt(tag)).toThrow(SecretBoxError);

    const iv = Buffer.from(envelope);
    iv.writeUInt8(iv.readUInt8(4) ^ 0x01, 4);
    expect(() => box.decrypt(iv)).toThrow(SecretBoxError);
  });

  it('rejects an unknown envelope version', () => {
    const box = createSecretBox(keyA);
    const envelope = box.encrypt('secret');
    envelope[0] = 2;

    expect(() => box.decrypt(envelope)).toThrow(/version is not supported/);
  });

  it('rejects a truncated envelope', () => {
    const box = createSecretBox(keyA);

    expect(() => box.decrypt(Buffer.alloc(10))).toThrow(/malformed/);
  });

  it('fails to decrypt with a different key', () => {
    const envelope = createSecretBox(keyA).encrypt('GOCSPX-secret');

    expect(() => createSecretBox(keyB).decrypt(envelope)).toThrow(/could not be decrypted/);
  });

  it('never includes the secret in an error message', () => {
    const envelope = createSecretBox(keyA).encrypt('GOCSPX-super-secret');
    let message = '';
    try {
      createSecretBox(keyB).decrypt(envelope);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toContain('GOCSPX-super-secret');
  });
});

describe('parseSecretKey', () => {
  it('accepts canonical base64 of exactly 32 bytes', () => {
    expect(parseSecretKey(keyA)).toHaveLength(32);
    expect(parseSecretKey(`  ${keyA}  `)).toHaveLength(32);
  });

  it.each([
    ['too short', 'c2hvcnQ='],
    ['plain text', 'not-a-key'],
    ['base64 of 31 bytes', Buffer.alloc(31, 1).toString('base64')],
    ['base64 of 33 bytes', Buffer.alloc(33, 1).toString('base64')],
    ['non-canonical padding', 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWZ='],
  ])('rejects %s', (_label, value) => {
    expect(() => parseSecretKey(value)).toThrow(SecretBoxError);
    expect(() => parseSecretKey(value)).toThrow(/exactly 32 bytes/);
  });

  it('rejects a raw buffer of the wrong length', () => {
    expect(() => createSecretBox(Buffer.alloc(16))).toThrow(/exactly 32 bytes/);
  });
});

describe('loadSocialSecretKey', () => {
  it('returns the parsed key when configured', () => {
    expect(loadSocialSecretKey({ SOCIAL_SECRET_KEY: keyA })).toHaveLength(32);
  });

  it('allows a missing key outside production', () => {
    expect(loadSocialSecretKey({ NODE_ENV: 'development' })).toBeNull();
    expect(loadSocialSecretKey({ NODE_ENV: 'test', SOCIAL_SECRET_KEY: '' })).toBeNull();
  });

  it('fails closed in production when the key is missing', () => {
    expect(() => loadSocialSecretKey({ NODE_ENV: 'production' })).toThrow(
      new RegExp(`${SOCIAL_SECRET_KEY_ENV} is required in production`),
    );
  });

  it('fails on an invalid key in every environment', () => {
    expect(() => loadSocialSecretKey({ SOCIAL_SECRET_KEY: 'invalid' })).toThrow(SecretBoxError);
    expect(() =>
      loadSocialSecretKey({ NODE_ENV: 'production', SOCIAL_SECRET_KEY: 'invalid' }),
    ).toThrow(/exactly 32 bytes/);
  });
});

describe('loadMfaSecretKey', () => {
  it('prefers the dedicated MFA key', () => {
    const key = loadMfaSecretKey({ MFA_SECRET_KEY: keyA, SOCIAL_SECRET_KEY: keyB });
    expect(key?.toString('base64')).toBe(keyA);
  });

  it('falls back to the social key for single-key deployments', () => {
    const key = loadMfaSecretKey({ SOCIAL_SECRET_KEY: keyB });
    expect(key?.toString('base64')).toBe(keyB);
  });

  it('allows a missing key outside production and fails closed in production', () => {
    expect(loadMfaSecretKey({ NODE_ENV: 'development' })).toBeNull();
    expect(() => loadMfaSecretKey({ NODE_ENV: 'production' })).toThrow(SecretBoxError);
  });

  it('rejects an invalid key', () => {
    expect(() => loadMfaSecretKey({ MFA_SECRET_KEY: 'not-base64' })).toThrow(/exactly 32 bytes/);
  });

  it('roundtrips a generated TOTP secret and never stores it in plaintext', () => {
    const key = loadMfaSecretKey({ MFA_SECRET_KEY: keyA });
    expect(key).not.toBeNull();
    const box = createSecretBox(key ?? Buffer.alloc(32));
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const envelope = box.encrypt(secret);

    expect(box.decrypt(envelope)).toBe(secret);
    expect(envelope.toString('ascii')).not.toContain(secret);
    expect(envelope.toString('base64')).not.toContain(Buffer.from(secret).toString('base64'));
  });
});
