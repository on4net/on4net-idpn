import { describe, expect, it } from 'vitest';

import { sanitizeAuditMetadata } from './sanitize.js';

describe('sanitizeAuditMetadata', () => {
  it('drops credential-shaped keys in every casing', () => {
    const sanitized = sanitizeAuditMetadata({
      apiKey: 'k-1',
      api_key: 'k-2',
      privateKey: 'pem',
      private_key: 'pem',
      Authorization: 'Bearer abc',
      authorization: 'Bearer abc',
      cookie: 'idpn_session=1',
      pin: '1234',
      otp: '987654',
      password: 'secret',
      clientSecret: 's',
      tokenHash: 'h',
      keep: 'yes',
    });

    expect(sanitized).toEqual({ keep: 'yes' });
  });

  it('keeps the aggregate counts that only look sensitive', () => {
    const sanitized = sanitizeAuditMetadata({
      revokedRefreshTokens: 3,
      revokedSessions: 1,
      revoked_refresh_tokens: 2,
    });

    expect(sanitized).toEqual({
      revokedRefreshTokens: 3,
      revokedSessions: 1,
      revoked_refresh_tokens: 2,
    });
  });

  it('scrubs nested objects and arrays', () => {
    const sanitized = sanitizeAuditMetadata({
      user: { id: 'u-1', password: 'x' },
      attempts: [{ otp: '1', reason: 'expired' }],
    });

    expect(sanitized).toEqual({
      user: { id: 'u-1' },
      attempts: [{ reason: 'expired' }],
    });
  });

  it('returns an empty object when there is no metadata', () => {
    expect(sanitizeAuditMetadata(undefined)).toEqual({});
  });
});
