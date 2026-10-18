import { describe, expect, it } from 'vitest';

import {
  exchangeAuthorizationCode,
  hashCode,
  issueAuthorizationCode,
  s256Challenge,
  verifyPkce,
  type AuthorizationCodeRecord,
  type AuthorizationCodeRepository,
} from './authorization-code.js';
import { validateAuthorizeRequest, type AuthorizeQuery } from './authorize-request.js';
import type { OAuthClient } from './client-repository.js';

const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';

const client: OAuthClient = {
  clientId: 'app-a',
  status: 'active',
  type: 'spa',
  redirectUris: ['https://app-a.example.com/callback', 'http://127.0.0.1:4000/cb'],
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  requirePkce: true,
  registrationPolicy: 'invite_only',
  mfaPolicy: 'optional',
  loginContexts: ['customer-admin', 'customer-team'],
  locales: ['fa-IR', 'en-US'],
};

const validQuery = (overrides: Partial<AuthorizeQuery> = {}): AuthorizeQuery => ({
  response_type: 'code',
  client_id: 'app-a',
  redirect_uri: 'https://app-a.example.com/callback',
  scope: 'openid profile',
  state: 'state-123',
  nonce: 'nonce-123',
  code_challenge: s256Challenge(verifier),
  code_challenge_method: 'S256',
  ...overrides,
});

describe('validateAuthorizeRequest', () => {
  it('accepts a fully specified request', () => {
    const result = validateAuthorizeRequest(validQuery(), client);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request).toMatchObject({
        redirectUri: 'https://app-a.example.com/callback',
        scopes: ['openid', 'profile'],
        state: 'state-123',
        nonce: 'nonce-123',
        codeChallengeMethod: 'S256',
      });
    }
  });

  it('requires client_id and rejects unknown or disabled clients without a redirect', () => {
    expect(validateAuthorizeRequest(validQuery({ client_id: undefined }), client)).toEqual({
      ok: false,
      error: { error: 'invalid_request', description: 'client_id is required' },
    });
    const disabled = validateAuthorizeRequest(validQuery(), { ...client, status: 'disabled' });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) {
      expect(disabled.error.error).toBe('unauthorized_client');
      expect(disabled.redirectUri).toBeUndefined();
    }
  });

  it('rejects an unregistered redirect_uri without redirecting', () => {
    const result = validateAuthorizeRequest(
      validQuery({ redirect_uri: 'https://evil.example/callback' }),
      client,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe('invalid_request');
      expect(result.redirectUri).toBeUndefined();
    }
  });

  it('rejects wildcard redirect URIs even if registered', () => {
    const wildcardClient = { ...client, redirectUris: ['https://app-a.example.com/*'] };
    const result = validateAuthorizeRequest(validQuery(), wildcardClient);
    expect(result.ok).toBe(false);
  });

  it('rejects a redirect_uri that only differs by a trailing slash', () => {
    const result = validateAuthorizeRequest(
      validQuery({ redirect_uri: 'https://app-a.example.com/callback/' }),
      client,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an unsupported response_type', () => {
    const result = validateAuthorizeRequest(validQuery({ response_type: 'token' }), client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe('unsupported_response_type');
      expect(result.redirectUri).toBe('https://app-a.example.com/callback');
      expect(result.state).toBe('state-123');
    }
  });

  it('requires state, nonce, PKCE and S256', () => {
    for (const query of [
      validQuery({ state: undefined }),
      validQuery({ nonce: undefined }),
      validQuery({ code_challenge: undefined }),
      validQuery({ code_challenge_method: 'plain' }),
    ]) {
      const result = validateAuthorizeRequest(query, client);
      expect(result.ok, JSON.stringify(query)).toBe(false);
    }
  });

  it('rejects a malformed PKCE challenge', () => {
    const result = validateAuthorizeRequest(validQuery({ code_challenge: 'too-short' }), client);
    expect(result.ok).toBe(false);
  });

  it('requires openid and only allows registered scopes', () => {
    const noOpenid = validateAuthorizeRequest(validQuery({ scope: 'profile' }), client);
    expect(noOpenid.ok).toBe(false);
    if (!noOpenid.ok) {
      expect(noOpenid.error.error).toBe('invalid_scope');
    }

    const unknown = validateAuthorizeRequest(validQuery({ scope: 'openid idp.admin' }), client);
    expect(unknown.ok).toBe(false);
  });

  it('validates prompt and max_age', () => {
    expect(validateAuthorizeRequest(validQuery({ prompt: 'consent' }), client).ok).toBe(true);
    expect(validateAuthorizeRequest(validQuery({ prompt: 'bogus' }), client).ok).toBe(false);
    expect(validateAuthorizeRequest(validQuery({ max_age: '300' }), client).ok).toBe(true);
    expect(validateAuthorizeRequest(validQuery({ max_age: '-1' }), client).ok).toBe(false);
    expect(validateAuthorizeRequest(validQuery({ max_age: 'abc' }), client).ok).toBe(false);
  });

  it('only accepts login contexts enabled for the client', () => {
    const ok = validateAuthorizeRequest(validQuery({ login_context: 'customer-admin' }), client);
    expect(ok.ok).toBe(true);

    const bad = validateAuthorizeRequest(validQuery({ login_context: 'platform-admin' }), client);
    expect(bad.ok).toBe(false);
  });
});

function memoryRepository(): AuthorizationCodeRepository & {
  records: Map<string, AuthorizationCodeRecord>;
} {
  const records = new Map<string, AuthorizationCodeRecord>();
  return {
    records,
    async create(record) {
      records.set(record.codeHash, record);
    },
    async findByHash(codeHash) {
      return records.get(codeHash) ?? null;
    },
    async markConsumed(codeHash, consumedAt) {
      const record = records.get(codeHash);
      if (record === undefined || record.consumedAt !== null) {
        return false;
      }
      records.set(codeHash, { ...record, consumedAt });
      return true;
    },
  };
}

const baseCodeInput = {
  clientId: 'app-a',
  userId: 'user-1',
  sessionId: 'session-1',
  redirectUri: 'https://app-a.example.com/callback',
  scope: ['openid', 'profile'],
  nonce: 'nonce-123',
  codeChallenge: s256Challenge(verifier),
  authTime: new Date('2026-10-18T10:00:00Z'),
  acr: 'urn:on4net:acr:pwd',
  amr: ['pwd'],
};

describe('issueAuthorizationCode', () => {
  it('creates a 256-bit code, stores only its hash and expires after 60s', async () => {
    const repository = memoryRepository();
    const now = new Date('2026-10-18T10:00:00Z');

    const { code, record } = await issueAuthorizationCode(repository, { ...baseCodeInput, now });

    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record.codeHash).toBe(hashCode(code));
    expect(record.codeHash).not.toContain(code);
    expect([...repository.records.keys()]).toEqual([hashCode(code)]);
    expect(record.expiresAt).toEqual(new Date('2026-10-18T10:01:00Z'));
    expect(record.consumedAt).toBeNull();
    expect(record.nonce).toBe('nonce-123');
  });

  it('produces a distinct code for every request', async () => {
    const repository = memoryRepository();
    const first = await issueAuthorizationCode(repository, baseCodeInput);
    const second = await issueAuthorizationCode(repository, baseCodeInput);
    expect(first.code).not.toBe(second.code);
  });
});

describe('exchangeAuthorizationCode', () => {
  const exchange = (repository: AuthorizationCodeRepository, code: string, overrides = {}) =>
    exchangeAuthorizationCode(repository, {
      code,
      clientId: 'app-a',
      redirectUri: 'https://app-a.example.com/callback',
      codeVerifier: verifier,
      ...overrides,
    });

  it('exchanges a valid code exactly once', async () => {
    const repository = memoryRepository();
    const { code } = await issueAuthorizationCode(repository, baseCodeInput);

    const result = await exchange(repository, code);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record).toMatchObject({
        userId: 'user-1',
        sessionId: 'session-1',
        nonce: 'nonce-123',
      });
    }

    const reuse = await exchange(repository, code);
    expect(reuse).toEqual({ ok: false, reason: 'code_already_used' });
  });

  it('rejects an unknown code', async () => {
    const repository = memoryRepository();
    await expect(exchange(repository, 'not-a-real-code')).resolves.toEqual({
      ok: false,
      reason: 'invalid_grant',
    });
  });

  it('rejects an expired code', async () => {
    const repository = memoryRepository();
    const { code } = await issueAuthorizationCode(repository, {
      ...baseCodeInput,
      now: new Date('2026-10-18T10:00:00Z'),
    });

    const result = await exchange(repository, code, { now: new Date('2026-10-18T12:00:00Z') });
    expect(result).toEqual({ ok: false, reason: 'code_expired' });
  });

  it('rejects a code presented by another client or redirect_uri', async () => {
    const repository = memoryRepository();
    const { code } = await issueAuthorizationCode(repository, baseCodeInput);

    await expect(exchange(repository, code, { clientId: 'app-b' })).resolves.toEqual({
      ok: false,
      reason: 'invalid_client',
    });
    await expect(
      exchange(repository, code, { redirectUri: 'https://app-a.example.com/other' }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_redirect_uri' });
  });

  it('requires the PKCE verifier and rejects a wrong one', async () => {
    const repository = memoryRepository();
    const { code } = await issueAuthorizationCode(repository, baseCodeInput);

    await expect(exchange(repository, code, { codeVerifier: undefined })).resolves.toEqual({
      ok: false,
      reason: 'pkce_required',
    });

    const wrongVerifier = 'a'.repeat(64);
    await expect(exchange(repository, code, { codeVerifier: wrongVerifier })).resolves.toEqual({
      ok: false,
      reason: 'invalid_grant',
    });
  });
});

describe('verifyPkce', () => {
  it('matches the RFC 7636 S256 example', () => {
    // RFC 7636 Appendix B.
    const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const rfcChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    expect(s256Challenge(rfcVerifier)).toBe(rfcChallenge);
    expect(verifyPkce(rfcVerifier, rfcChallenge)).toBe(true);
    expect(verifyPkce(`${rfcVerifier}x`, rfcChallenge)).toBe(false);
  });

  it('rejects a verifier that violates the allowed character set', () => {
    expect(verifyPkce('short', s256Challenge('short'))).toBe(false);
    expect(verifyPkce('a'.repeat(43) + '!', s256Challenge('a'.repeat(43) + '!'))).toBe(false);
  });
});
