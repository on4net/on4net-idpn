import Fastify, { type FastifyInstance } from 'fastify';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { hashPassword, type Argon2Params } from '../src/auth/password.js';
import {
  issueAuthorizationCode,
  s256Challenge,
  type AuthorizationCodeRecord,
  type AuthorizationCodeRepository,
} from '../src/oidc/authorization-code.js';
import type { ClientAuthClientRecord, ClientAuthRepository } from '../src/oidc/client-auth.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import type { RefreshTokenRecord, RefreshTokenRepository } from '../src/oidc/refresh-token.js';
import { registerTokenRoute } from '../src/oidc/token-route.js';
import type { TokenProfile } from '../src/oidc/token-claims.js';

const FAST: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const issuer = 'https://auth.example.com';
const secret = 'super-secret-value';

const profile: TokenProfile = {
  id: 'user-1',
  username: 'sara',
  email: 'sara@example.com',
  emailVerified: true,
  displayName: 'Sara',
  locale: 'fa-IR',
  tenantId: 'tenant-1',
};

function memoryCodes() {
  const records = new Map<string, AuthorizationCodeRecord>();
  const repository: AuthorizationCodeRepository & {
    records: Map<string, AuthorizationCodeRecord>;
  } = {
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
  return repository;
}

function memoryRefreshTokens() {
  const records = new Map<string, RefreshTokenRecord>();
  const repository: RefreshTokenRepository & { records: Map<string, RefreshTokenRecord> } = {
    records,
    async create(record) {
      records.set(record.tokenHash, record);
    },
    async findByHash(tokenHash) {
      return records.get(tokenHash) ?? null;
    },
    async markRotated(tokenHash, rotatedAt, replacedById) {
      const record = records.get(tokenHash);
      if (record === undefined || record.rotatedAt !== null || record.revokedAt !== null) {
        return false;
      }
      records.set(tokenHash, { ...record, rotatedAt, replacedBy: replacedById });
      return true;
    },
    async revokeFamily(familyId, revokedAt) {
      let count = 0;
      for (const [hash, record] of records) {
        if (record.familyId === familyId && record.revokedAt === null) {
          records.set(hash, { ...record, revokedAt });
          count += 1;
        }
      }
      return count;
    },
    async revokeByHash(tokenHash, revokedAt) {
      const record = records.get(tokenHash);
      if (record === undefined || record.revokedAt !== null) {
        return false;
      }
      records.set(tokenHash, { ...record, revokedAt });
      return true;
    },
  };
  return repository;
}

async function buildClients(): Promise<ClientAuthRepository> {
  const publicClient: ClientAuthClientRecord = {
    clientId: 'spa-app',
    status: 'active',
    type: 'spa',
    requirePkce: true,
    accessTokenTtl: 600,
    refreshTokenTtl: 2_592_000,
    scopes: ['openid', 'profile', 'offline_access'],
    secretHashes: [],
  };
  const confidentialClient: ClientAuthClientRecord = {
    clientId: 'web-app',
    status: 'active',
    type: 'web',
    requirePkce: true,
    accessTokenTtl: 600,
    refreshTokenTtl: 2_592_000,
    scopes: ['openid', 'profile', 'offline_access'],
    secretHashes: [await hashPassword(secret, FAST)],
  };
  const m2m: ClientAuthClientRecord = {
    clientId: 'service',
    status: 'active',
    type: 'm2m',
    requirePkce: false,
    accessTokenTtl: 600,
    refreshTokenTtl: 2_592_000,
    scopes: ['reports:read'],
    secretHashes: [await hashPassword(secret, FAST)],
  };
  const byId = new Map(
    [publicClient, confidentialClient, m2m].map((client) => [client.clientId, client]),
  );

  return {
    async findForAuth(clientId) {
      return byId.get(clientId) ?? null;
    },
  };
}

interface HarnessOptions {
  now?: Date;
  sessionValid?: boolean;
  clientAdminEligible?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  const app: FastifyInstance = Fastify({ logger: false });
  const codes = memoryCodes();
  const refreshTokens = memoryRefreshTokens();
  const keys = new SigningKeyManager(new MemorySigningKeyRepository());
  const clients = await buildClients();

  registerTokenRoute(app, {
    issuer,
    clients,
    codes,
    refreshTokens,
    keys,
    users: {
      async findProfile(userId) {
        return userId === profile.id ? profile : null;
      },
    },
    sessions: {
      async read(sid) {
        if (options.sessionValid === false) {
          return null;
        }
        return {
          sid,
          userId: profile.id,
          createdAt: '2026-10-18T09:00:00.000Z',
          lastSeenAt: '2026-10-18T09:00:00.000Z',
          authTime: '2026-10-18T09:00:00.000Z',
          idleExpiresAt: '2026-10-18T09:30:00.000Z',
          absoluteExpiresAt: '2026-10-18T17:00:00.000Z',
          amr: ['pwd'],
          acr: 'urn:on4net:acr:pwd',
        };
      },
    },
    now: () => options.now ?? new Date('2026-10-18T12:00:00Z'),
    isClientAdminEligible: async () => options.clientAdminEligible ?? true,
  });
  await app.ready();
  return { app, codes, refreshTokens, keys };
}

async function seedCode(
  codes: AuthorizationCodeRepository,
  scope: string[] = ['openid', 'profile'],
  overrides: { clientId?: string; redirectUri?: string } = {},
): Promise<string> {
  const { code } = await issueAuthorizationCode(codes, {
    clientId: overrides.clientId ?? 'spa-app',
    userId: profile.id,
    sessionId: 'session-1',
    redirectUri: overrides.redirectUri ?? 'https://spa.example.com/cb',
    scope,
    nonce: 'nonce-1',
    codeChallenge: s256Challenge(verifier),
    authTime: new Date('2026-10-18T09:00:00Z'),
    acr: 'urn:on4net:acr:pwd',
    amr: ['pwd'],
    now: new Date('2026-10-18T12:00:00Z'),
  });
  return code;
}

describe('POST /oauth2/token — authorization_code', () => {
  it('accepts the RFC 6749 form-encoded body with client_secret_basic authentication', async () => {
    const { app, codes } = await harness();
    const redirectUri = 'https://web.example.com/cb';
    const code = await seedCode(codes, ['openid', 'profile'], {
      clientId: 'web-app',
      redirectUri,
    });

    const response = await request(app.server)
      .post('/oauth2/token')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Authorization', `Basic ${Buffer.from(`web-app:${secret}`, 'utf8').toString('base64')}`)
      .send(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }).toString(),
      )
      .expect(200);

    expect(response.body).toMatchObject({ token_type: 'Bearer', expires_in: 600 });
    expect(response.body.access_token).toEqual(expect.any(String));
    await app.close();
  });

  it('issues access and ID tokens with correct iss, aud, exp and sid', async () => {
    const { app, codes, keys } = await harness();
    const code = await seedCode(codes);

    const response = await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://spa.example.com/cb',
        code_verifier: verifier,
        client_id: 'spa-app',
      })
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ token_type: 'Bearer', expires_in: 600 });
    expect(response.body.refresh_token).toBeUndefined();

    const access = await keys.verify(response.body.access_token, { issuer, audience: 'spa-app' });
    expect(access).toMatchObject({
      iss: issuer,
      aud: 'spa-app',
      sub: profile.id,
      sid: 'session-1',
      client_id: 'spa-app',
      tenant_id: 'tenant-1',
    });
    expect(access.exp).toBe((access.iat ?? 0) + 600);

    const idToken = await keys.verify(response.body.id_token, { issuer, audience: 'spa-app' });
    expect(idToken).toMatchObject({
      nonce: 'nonce-1',
      email: profile.email,
      preferred_username: 'sara',
    });
    expect(idToken).not.toHaveProperty('roles');

    await app.close();
  });

  it('refuses the delegated admin scope when the user is no longer eligible', async () => {
    const denied = await harness({ clientAdminEligible: false });
    const code = await seedCode(denied.codes, ['openid', 'idp.client-admin']);

    const response = await request(denied.app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://spa.example.com/cb',
        code_verifier: verifier,
        client_id: 'spa-app',
      })
      .expect(400);
    expect(response.body).toMatchObject({ error: 'access_denied' });
    await denied.app.close();

    const allowed = await harness({ clientAdminEligible: true });
    const allowedCode = await seedCode(allowed.codes, ['openid', 'idp.client-admin']);
    const issued = await request(allowed.app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code: allowedCode,
        redirect_uri: 'https://spa.example.com/cb',
        code_verifier: verifier,
        client_id: 'spa-app',
      })
      .expect(200);
    expect(issued.body.scope).toBe('openid idp.client-admin');
    await allowed.app.close();
  });

  it('issues a refresh token only with offline_access', async () => {
    const { app, codes } = await harness();
    const code = await seedCode(codes, ['openid', 'offline_access']);

    const response = await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://spa.example.com/cb',
        code_verifier: verifier,
        client_id: 'spa-app',
      })
      .expect(200);

    expect(response.body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await app.close();
  });

  it('rejects a wrong PKCE verifier and a reused code', async () => {
    const { app, codes } = await harness();
    const code = await seedCode(codes);

    await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://spa.example.com/cb',
        code_verifier: 'b'.repeat(64),
        client_id: 'spa-app',
      })
      .expect(400)
      .expect((response) => expect(response.body.error).toBe('invalid_grant'));

    await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://spa.example.com/cb',
        code_verifier: verifier,
        client_id: 'spa-app',
      })
      .expect(200);

    await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://spa.example.com/cb',
        code_verifier: verifier,
        client_id: 'spa-app',
      })
      .expect(400)
      .expect((response) => expect(response.body.error).toBe('invalid_grant'));

    await app.close();
  });

  it('requires client authentication for confidential clients', async () => {
    const { app, codes } = await harness();
    const code = await seedCode(codes);

    await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://spa.example.com/cb',
        code_verifier: verifier,
        client_id: 'web-app',
      })
      .expect(400);

    await request(app.server)
      .post('/oauth2/token')
      .set('Authorization', `Basic ${Buffer.from('web-app:wrong-secret').toString('base64')}`)
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://spa.example.com/cb',
        code_verifier: verifier,
      })
      .expect(400);
    await app.close();
  });

  it('rejects an unsupported grant type', async () => {
    const { app } = await harness();

    await request(app.server)
      .post('/oauth2/token')
      .send({ grant_type: 'password', client_id: 'spa-app' })
      .expect(400)
      .expect((response) => expect(response.body.error).toBe('unsupported_grant_type'));

    await app.close();
  });
});

describe('POST /oauth2/token — refresh_token', () => {
  it('rotates the refresh token and rejects reuse, revoking the family', async () => {
    const { app, codes, refreshTokens } = await harness();
    const code = await seedCode(codes, ['openid', 'offline_access']);

    const first = await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://spa.example.com/cb',
        code_verifier: verifier,
        client_id: 'spa-app',
      })
      .expect(200);

    const rotated = await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: first.body.refresh_token,
        client_id: 'spa-app',
      })
      .expect(200);

    expect(rotated.body.refresh_token).not.toBe(first.body.refresh_token);
    expect(rotated.body.id_token).toBeUndefined();

    // Replaying the old token is reuse: invalid_grant and the whole family dies.
    await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: first.body.refresh_token,
        client_id: 'spa-app',
      })
      .expect(400)
      .expect((response) => expect(response.body.error).toBe('invalid_grant'));

    const active = [...refreshTokens.records.values()].filter(
      (record) => record.revokedAt === null,
    );
    expect(active).toHaveLength(0);

    // The new token is also dead now.
    await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: rotated.body.refresh_token,
        client_id: 'spa-app',
      })
      .expect(400)
      .expect((response) => expect(response.body.error).toBe('invalid_grant'));

    await app.close();
  });

  it('rejects an expired or revoked refresh token', async () => {
    const { app, codes, refreshTokens } = await harness();
    const code = await seedCode(codes, ['openid', 'offline_access']);
    const issued = await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://spa.example.com/cb',
        code_verifier: verifier,
        client_id: 'spa-app',
      })
      .expect(200);

    const stored = [...refreshTokens.records.values()][0];
    if (stored === undefined) {
      throw new Error('refresh token was not stored');
    }
    refreshTokens.records.set(stored.tokenHash, {
      ...stored,
      expiresAt: new Date('2026-10-01T00:00:00Z'),
    });

    await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: issued.body.refresh_token,
        client_id: 'spa-app',
      })
      .expect(400);

    await app.close();
  });

  it('rejects refresh when the session was revoked', async () => {
    const { app, codes } = await harness({ sessionValid: false });
    const code = await seedCode(codes, ['openid', 'offline_access']);
    const issued = await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://spa.example.com/cb',
        code_verifier: verifier,
        client_id: 'spa-app',
      })
      .expect(200);

    await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: issued.body.refresh_token,
        client_id: 'spa-app',
      })
      .expect(400)
      .expect((response) => expect(response.body.error).toBe('invalid_grant'));

    await app.close();
  });
});

describe('POST /oauth2/token — client_credentials', () => {
  it('issues an access token for a service client and rejects openid', async () => {
    const { app, keys } = await harness();
    const basic = `Basic ${Buffer.from(`service:${secret}`).toString('base64')}`;

    const response = await request(app.server)
      .post('/oauth2/token')
      .set('Authorization', basic)
      .send({ grant_type: 'client_credentials', scope: 'reports:read' })
      .expect(200);

    const claims = await keys.verify(response.body.access_token, { issuer, audience: 'service' });
    expect(claims).toMatchObject({ sub: 'service', aud: 'service', scope: 'reports:read' });

    await request(app.server)
      .post('/oauth2/token')
      .set('Authorization', basic)
      .send({ grant_type: 'client_credentials', scope: 'openid' })
      .expect(400);

    await app.close();
  });
});
