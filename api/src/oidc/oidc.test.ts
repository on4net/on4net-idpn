import { decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  buildOpenIdConfiguration,
  DISCOVERY_CACHE_CONTROL,
  JWKS_CACHE_CONTROL,
} from './discovery.js';
import { MemorySigningKeyRepository, SigningKeyManager, SIGNING_ALG } from './keys.js';
import type { StoredSigningKey } from './key-types.js';

const issuer = 'https://auth.example.com';

describe('buildOpenIdConfiguration', () => {
  it('matches the documented discovery document', () => {
    const config = buildOpenIdConfiguration({ issuer });

    expect(config).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: `${issuer}/oauth2/token`,
      userinfo_endpoint: `${issuer}/oauth2/userinfo`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      end_session_endpoint: `${issuer}/oauth2/logout`,
      revocation_endpoint: `${issuer}/oauth2/revoke`,
      introspection_endpoint: `${issuer}/oauth2/introspect`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    });
    expect(config.grant_types_supported).toEqual([
      'authorization_code',
      'refresh_token',
      'client_credentials',
    ]);
    expect(config.scopes_supported).toContain('openid');
    expect(config.claims_supported).toContain('sid');
  });

  it('normalizes a trailing slash in the issuer', () => {
    expect(buildOpenIdConfiguration({ issuer: `${issuer}/` }).issuer).toBe(issuer);
    expect(buildOpenIdConfiguration({ issuer: `${issuer}/` }).jwks_uri).toBe(
      `${issuer}/.well-known/jwks.json`,
    );
  });

  it('publishes the documented cache headers', () => {
    expect(DISCOVERY_CACHE_CONTROL).toBe('public, max-age=3600');
    expect(JWKS_CACHE_CONTROL).toBe('public, max-age=300');
  });
});

describe('SigningKeyManager', () => {
  it('creates one ES256 key with a thumbprint kid', async () => {
    const manager = new SigningKeyManager(new MemorySigningKeyRepository());
    const key = await manager.ensureKey();

    expect(key.alg).toBe('ES256');
    expect(key.publicJwk.kty).toBe('EC');
    expect(key.publicJwk.crv).toBe('P-256');
    expect(key.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('publishes only public members in the JWKS', async () => {
    const manager = new SigningKeyManager(new MemorySigningKeyRepository());
    const jwks = await manager.jwks();

    expect(jwks.keys).toHaveLength(1);
    const [key] = jwks.keys;
    expect(key).toMatchObject({ kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256' });
    expect(key?.x).toBeDefined();
    expect(key).not.toHaveProperty('d');
  });

  it('signs a token with the active kid and ES256', async () => {
    const manager = new SigningKeyManager(new MemorySigningKeyRepository());
    const key = await manager.ensureKey();

    const token = await manager.signAccessToken(
      { scope: 'openid', sid: 'abc' },
      { issuer, audience: 'app-a', subject: 'user-1', expiresInSeconds: 600 },
    );

    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe(SIGNING_ALG);
    expect(header.kid).toBe(key.kid);
    expect(header.typ).toBe('JWT');
  });

  it('verifies its own token and exposes the claims', async () => {
    const manager = new SigningKeyManager(new MemorySigningKeyRepository());
    const token = await manager.signAccessToken(
      { scope: 'openid' },
      { issuer, audience: 'app-a', subject: 'user-1', expiresInSeconds: 600 },
    );

    const payload = await manager.verify(token, { issuer, audience: 'app-a' });
    expect(payload).toMatchObject({ iss: issuer, aud: 'app-a', sub: 'user-1' });
  });

  it('rejects alg=none and a tampered signature', async () => {
    const manager = new SigningKeyManager(new MemorySigningKeyRepository());
    const token = await manager.signAccessToken(
      { scope: 'openid' },
      { issuer, audience: 'app-a', subject: 'user-1', expiresInSeconds: 600 },
    );

    const [header, payload] = token.split('.');
    const algNone = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    )}.${payload}.`;
    expect(header).toBeDefined();

    await expect(manager.verify(algNone, { issuer, audience: 'app-a' })).rejects.toThrow();

    const [h, p, s] = token.split('.');
    const tampered = `${h}.${p}.${(s ?? '').slice(0, -4)}AAAA`;
    await expect(manager.verify(tampered, { issuer, audience: 'app-a' })).rejects.toThrow();
  });

  it('rejects a token issued for another issuer or audience', async () => {
    const manager = new SigningKeyManager(new MemorySigningKeyRepository());
    const token = await manager.signAccessToken(
      { scope: 'openid' },
      { issuer, audience: 'app-a', subject: 'user-1', expiresInSeconds: 600 },
    );

    await expect(
      manager.verify(token, { issuer: 'https://evil.example', audience: 'app-a' }),
    ).rejects.toThrow();
    await expect(manager.verify(token, { issuer, audience: 'app-b' })).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const manager = new SigningKeyManager(new MemorySigningKeyRepository());
    const issuedAt = Math.floor(Date.now() / 1000) - 1200;
    const token = await manager.signAccessToken(
      { scope: 'openid' },
      { issuer, audience: 'app-a', subject: 'user-1', expiresInSeconds: 600, issuedAt },
    );

    await expect(manager.verify(token, { issuer, audience: 'app-a' })).rejects.toThrow();
  });

  it('rotates to a new active key and keeps the old one in the JWKS', async () => {
    const repository = new MemorySigningKeyRepository();
    const manager = new SigningKeyManager(repository, () => new Date('2026-10-18T10:00:00Z'));
    const first = await manager.ensureKey();

    const second = await manager.rotate();
    expect(second.active.kid).not.toBe(first.kid);

    const keys = await repository.list();
    expect(keys.map((key) => key.status).sort()).toEqual(['active', 'retired']);

    const jwks = await manager.jwks();
    expect(jwks.keys).toHaveLength(2);
    expect(jwks.keys.map((key) => key.kid)).toContain(first.kid);

    // Tokens signed before the rotation still verify (JWKS overlap).
    const oldToken = await signWith(first);
    await expect(manager.verify(oldToken, { issuer, audience: 'app-a' })).resolves.toMatchObject({
      sub: 'user-1',
    });

    // A token issued after the rotation carries the new kid.
    const newToken = await manager.signAccessToken(
      { scope: 'openid' },
      { issuer, audience: 'app-a', subject: 'user-1', expiresInSeconds: 600 },
    );
    expect(decodeProtectedHeader(newToken).kid).toBe(second.active.kid);
    await expect(
      manager.verify(newToken, {
        issuer,
        audience: 'app-a',
        currentDate: new Date('2026-10-18T10:00:00Z'),
      }),
    ).resolves.toMatchObject({
      sub: 'user-1',
    });
  });

  it('keeps revoked keys out of the JWKS', async () => {
    const repository = new MemorySigningKeyRepository();
    const manager = new SigningKeyManager(repository);
    const first = await manager.ensureKey();
    const second = await manager.rotate();
    await repository.updateStatus(first.kid, 'revoked', new Date());

    const jwks = await manager.jwks();
    expect(jwks.keys.map((key) => key.kid)).toEqual([second.active.kid]);
  });
});

async function signWith(key: StoredSigningKey): Promise<string> {
  const { SignJWT, importJWK } = await import('jose');
  const privateKey = await importJWK(key.privateJwk, 'ES256');
  return new SignJWT({ scope: 'openid' })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience('app-a')
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
    .sign(privateKey);
}
