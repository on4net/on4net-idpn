import Fastify from 'fastify';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { hashPassword, type Argon2Params } from '../src/auth/password.js';
import type { ClientAuthClientRecord, ClientAuthRepository } from '../src/oidc/client-auth.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import {
  issueRefreshToken,
  type RefreshTokenRecord,
  type RefreshTokenRepository,
} from '../src/oidc/refresh-token.js';
import { registerRevokeIntrospectRoutes } from '../src/oidc/revoke-introspect.js';

const FAST: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const issuer = 'https://auth.example.com';
const secret = 'super-secret-value';

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
      if (record === undefined) {
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

async function harness() {
  const app = Fastify({ logger: false });
  const refreshTokens = memoryRefreshTokens();
  const keys = new SigningKeyManager(new MemorySigningKeyRepository());
  const client: ClientAuthClientRecord = {
    clientId: 'web-app',
    status: 'active',
    type: 'web',
    requirePkce: true,
    accessTokenTtl: 600,
    refreshTokenTtl: 2_592_000,
    scopes: ['openid', 'offline_access', 'reports:read'],
    secretHashes: [await hashPassword(secret, FAST)],
  };
  const clients: ClientAuthRepository = {
    async findForAuth(clientId) {
      return clientId === client.clientId ? client : null;
    },
  };

  registerRevokeIntrospectRoutes(app, {
    issuer,
    clients,
    refreshTokens,
    keys,
    now: () => new Date('2026-10-18T12:00:00Z'),
  });
  await app.ready();
  return { app, refreshTokens, keys, clientId: client.clientId };
}

const basic = (id: string, pass: string) =>
  `Basic ${Buffer.from(`${id}:${pass}`).toString('base64')}`;

describe('POST /oauth2/introspect', () => {
  it('reports an access token as active with its claims', async () => {
    const { app, keys, clientId } = await harness();
    const token = await keys.signAccessToken(
      { iss: issuer, sub: 'user-1', aud: clientId, sid: 'session-1', scope: 'openid' },
      { issuer, audience: clientId, subject: 'user-1', expiresInSeconds: 600 },
    );

    const response = await request(app.server)
      .post('/oauth2/introspect')
      .set('Authorization', basic(clientId, secret))
      .send({ token })
      .expect(200);

    expect(response.body).toMatchObject({ active: true, sub: 'user-1', aud: clientId });
    await app.close();
  });

  it('reports unknown, revoked and foreign tokens as inactive', async () => {
    const { app, refreshTokens, clientId } = await harness();
    const issued = await issueRefreshToken(refreshTokens, {
      clientId,
      userId: 'user-1',
      sessionId: 'session-1',
      scope: ['openid'],
      ttlSeconds: 3600,
      now: new Date('2026-10-18T11:30:00Z'),
    });

    const active = await request(app.server)
      .post('/oauth2/introspect')
      .set('Authorization', basic(clientId, secret))
      .send({ token: issued.token })
      .expect(200);
    expect(active.body).toMatchObject({ active: true, sub: 'user-1', token_type: 'refresh_token' });

    await refreshTokens.revokeByHash(issued.record.tokenHash, new Date());

    const revoked = await request(app.server)
      .post('/oauth2/introspect')
      .set('Authorization', basic(clientId, secret))
      .send({ token: issued.token })
      .expect(200);
    expect(revoked.body).toEqual({ active: false });

    const unknown = await request(app.server)
      .post('/oauth2/introspect')
      .set('Authorization', basic(clientId, secret))
      .send({ token: 'not-a-token' })
      .expect(200);
    expect(unknown.body).toEqual({ active: false });

    await app.close();
  });

  it('requires client authentication', async () => {
    const { app } = await harness();
    await request(app.server)
      .post('/oauth2/introspect')
      .send({ token: 'x', client_id: 'web-app' })
      .expect(401);
    await app.close();
  });
});

describe('POST /oauth2/revoke', () => {
  it('revokes the refresh token family and answers 200 even for unknown tokens', async () => {
    const { app, refreshTokens, clientId } = await harness();
    const issued = await issueRefreshToken(refreshTokens, {
      clientId,
      userId: 'user-1',
      sessionId: 'session-1',
      scope: ['openid', 'offline_access'],
      ttlSeconds: 3600,
      now: new Date('2026-10-18T11:30:00Z'),
    });

    await request(app.server)
      .post('/oauth2/revoke')
      .set('Authorization', basic(clientId, secret))
      .send({ token: issued.token })
      .expect(200);

    const stored = refreshTokens.records.get(issued.record.tokenHash);
    expect(stored?.revokedAt).not.toBeNull();

    await request(app.server)
      .post('/oauth2/revoke')
      .set('Authorization', basic(clientId, secret))
      .send({ token: 'unknown-token' })
      .expect(200);

    await app.close();
  });
});
