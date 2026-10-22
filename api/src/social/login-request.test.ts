import { describe, expect, it } from 'vitest';

import {
  AUTHORIZE_LOGIN_REQUEST_TTL_SECONDS,
  SOCIAL_LOGIN_REQUEST_TTL_SECONDS,
  codeChallengeFor,
  createSocialLoginTransaction,
  isSameOriginAuthorizeUrl,
  transactionMatches,
} from './login-request.js';
import {
  MemorySocialTransactionStore,
  RedisSocialTransactionStore,
  type SocialTransactionRedis,
} from './transaction-store.js';

const issuer = 'https://auth.example.com';

const transaction = (overrides: { provider?: 'google' | 'facebook'; clientId?: string } = {}) =>
  createSocialLoginTransaction({
    clientId: overrides.clientId ?? 'app-a',
    provider: overrides.provider ?? 'google',
    redirectUri: `${issuer}/oauth2/social/${overrides.clientId ?? 'app-a'}/${overrides.provider ?? 'google'}/callback`,
    returnTo: `${issuer}/oauth2/authorize?client_id=${overrides.clientId ?? 'app-a'}&state=abc`,
    now: new Date('2026-10-19T10:00:00Z'),
  });

class FakeRedis implements SocialTransactionRedis {
  readonly values = new Map<string, string>();
  readonly writes: { key: string; seconds: number }[] = [];

  async getdel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }

  async set(key: string, value: string, _mode: 'EX', seconds: number): Promise<unknown> {
    this.values.set(key, value);
    this.writes.push({ key, seconds });
    return 'OK';
  }
}

describe('social login transactions', () => {
  it('generates an unguessable state, nonce and PKCE verifier', () => {
    const first = transaction();
    const second = transaction();

    expect(first.state).not.toBe(second.state);
    expect(first.state.length).toBeGreaterThanOrEqual(43);
    expect(first.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(first.codeChallenge).toBe(codeChallengeFor(first.codeVerifier));
    expect(first.codeChallenge).not.toBe(first.codeVerifier);
    // 32 random bytes encode to 43 base64url characters.
    expect(first.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.createdAt).toBe('2026-10-19T10:00:00.000Z');
  });

  it('only issues a nonce for Google, which verifies it inside the ID token', () => {
    expect(transaction({ provider: 'google' }).nonce).not.toBeNull();
    expect(transaction({ provider: 'facebook' }).nonce).toBeNull();
  });

  it('binds a transaction to its client and provider', () => {
    const started = transaction({ clientId: 'app-a', provider: 'google' });

    expect(transactionMatches(started, 'app-a', 'google')).toBe(true);
    expect(transactionMatches(started, 'app-b', 'google')).toBe(false);
    expect(transactionMatches(started, 'app-a', 'facebook')).toBe(false);
  });

  it('accepts only the issuer origin /oauth2/authorize as a return target', () => {
    expect(isSameOriginAuthorizeUrl(`${issuer}/oauth2/authorize?client_id=app-a`, issuer)).toBe(
      true,
    );
    expect(isSameOriginAuthorizeUrl('https://evil.example/oauth2/authorize', issuer)).toBe(false);
    expect(isSameOriginAuthorizeUrl(`${issuer}/admin`, issuer)).toBe(false);
    expect(isSameOriginAuthorizeUrl('/oauth2/authorize?client_id=app-a', issuer)).toBe(false);
    expect(isSameOriginAuthorizeUrl('not a url', issuer)).toBe(false);
  });
});

describe('RedisSocialTransactionStore', () => {
  it('stores a login request with a 10 minute TTL and consumes it once', async () => {
    const redis = new FakeRedis();
    const store = new RedisSocialTransactionStore(redis);

    const id = await store.createAuthorizeLoginRequest({
      clientId: 'app-a',
      authorizeUrl: `${issuer}/oauth2/authorize?client_id=app-a`,
    });

    expect(redis.writes.at(-1)?.seconds).toBe(AUTHORIZE_LOGIN_REQUEST_TTL_SECONDS);
    expect(AUTHORIZE_LOGIN_REQUEST_TTL_SECONDS).toBe(600);
    await expect(store.takeAuthorizeLoginRequest(id)).resolves.toMatchObject({ clientId: 'app-a' });
    await expect(store.takeAuthorizeLoginRequest(id)).resolves.toBeNull();
  });

  it('stores a social state with a 10 minute TTL and rejects replays', async () => {
    const redis = new FakeRedis();
    const store = new RedisSocialTransactionStore(redis);
    const started = transaction();

    await store.saveSocialLoginRequest(started);

    expect(redis.writes.at(-1)?.seconds).toBe(SOCIAL_LOGIN_REQUEST_TTL_SECONDS);
    expect(SOCIAL_LOGIN_REQUEST_TTL_SECONDS).toBe(600);
    await expect(store.takeSocialLoginRequest(started.state)).resolves.toMatchObject({
      clientId: 'app-a',
      provider: 'google',
    });
    await expect(store.takeSocialLoginRequest(started.state)).resolves.toBeNull();
  });

  it('treats a corrupted cache entry as expired', async () => {
    const redis = new FakeRedis();
    const store = new RedisSocialTransactionStore(redis);
    const started = transaction();

    redis.values.set(`idpn:social:state:${started.state}`, '{"clientId":"app-a"}');
    await expect(store.takeSocialLoginRequest(started.state)).resolves.toBeNull();

    redis.values.set(`idpn:social:state:${started.state}`, 'not-json');
    await expect(store.takeSocialLoginRequest(started.state)).resolves.toBeNull();
  });
});

describe('MemorySocialTransactionStore', () => {
  it('expires records after the TTL and deletes them on consumption', async () => {
    let clock = 1_000;
    const store = new MemorySocialTransactionStore({ now: () => clock });
    const started = transaction();
    await store.saveSocialLoginRequest(started);

    clock += SOCIAL_LOGIN_REQUEST_TTL_SECONDS * 1000 - 1;
    await expect(store.takeSocialLoginRequest(started.state)).resolves.not.toBeNull();

    const second = transaction();
    await store.saveSocialLoginRequest(second);
    clock += SOCIAL_LOGIN_REQUEST_TTL_SECONDS * 1000 + 1;
    await expect(store.takeSocialLoginRequest(second.state)).resolves.toBeNull();
  });
});
