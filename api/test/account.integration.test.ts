import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaAccountProfileRepository } from '../src/account/prisma-account-repository.js';
import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaAdminSessionRepository } from '../src/admin/sessions/prisma-session-repository.js';
import { createPrismaPasswordStore } from '../src/audit/prisma-audit.js';
import { hashPassword, verifyPassword, type Argon2Params } from '../src/auth/password.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { buildServer } from '../src/server.js';
import { RedisSessionCache } from '../src/session/redis-cache.js';
import { RedisSessionStore } from '../src/session/store.js';
import type { IdpSession } from '../src/session/types.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3100';
const userPassword = 'user-password-123';
const FAST_ARGON2: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };

let container: StartedPostgreSqlContainer | undefined;
let redisContainer: StartedRedisContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let redis: Redis;
let prisma: PrismaClient;
let store: RedisSessionStore;
let app: ReturnType<typeof buildServer>;
let tenantId: string;
let clientId: string;

const connectionString = (): string => connectionStringValue;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

async function createUser(username: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      tenantId,
      username,
      email: `${username}@example.com`,
      displayName: `Display ${username}`,
      status: 'active',
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(userPassword, FAST_ARGON2),
    },
  });
  return user.id;
}

async function createSession(userId: string): Promise<IdpSession> {
  const session = await store.create({
    userId,
    clientId: 'app-a',
    amr: ['pwd'],
    acr: 'urn:on4net:acr:pwd',
    ip: '10.0.0.1',
    userAgent: 'vitest-agent',
  });
  await prisma.session.create({
    data: {
      id: session.sid,
      userId,
      clientId,
      createdAt: new Date(session.createdAt),
      lastSeenAt: new Date(session.lastSeenAt),
      idleExpiresAt: new Date(session.idleExpiresAt),
      absoluteExpiresAt: new Date(session.absoluteExpiresAt),
      ip: session.ip ?? null,
      userAgent: session.userAgent ?? null,
      amr: session.amr,
      acr: session.acr,
    },
  });
  return session;
}

async function createRefreshToken(userId: string, sessionId: string): Promise<string> {
  const token = await prisma.refreshToken.create({
    data: {
      tokenHash: randomUUID(),
      familyId: randomUUID(),
      clientId,
      userId,
      sessionId,
      scope: ['openid', 'offline_access'],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return token.id;
}

const cookie = (session: IdpSession): string => `idpn_session=${session.sid}`;
const sameOrigin = { Origin: issuer };

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_account_${Date.now()}`;
    serverClient = new Client({ connectionString: external });
    await serverClient.connect();
    await serverClient.query(`CREATE DATABASE "${scratchDatabase}"`);
    const url = new URL(external);
    url.pathname = `/${scratchDatabase}`;
    connectionStringValue = url.toString();
  } else {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(180_000)
      .start();
    connectionStringValue = container.getConnectionUri();
  }
  await migrateDeploy();
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionStringValue }) });

  const externalRedis = process.env.TEST_REDIS_URL;
  if (externalRedis !== undefined && externalRedis !== '') {
    redis = new Redis(externalRedis);
  } else {
    redisContainer = await new RedisContainer('redis:7-alpine').withStartupTimeout(180_000).start();
    redis = new Redis(redisContainer.getConnectionUrl());
  }
  store = new RedisSessionStore({
    cache: new RedisSessionCache(redis),
    policy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600, maxConcurrentSessions: 0 },
  });

  const keys = new SigningKeyManager(new MemorySigningKeyRepository());
  await keys.ensureKey();
  const repository = createPrismaAdminSessionRepository(prisma);
  const audit = createPrismaAdminAudit(prisma);

  app = buildServer({
    issuer,
    keys,
    account: {
      sessions: store,
      repository,
      profiles: createPrismaAccountProfileRepository(prisma),
      passwords: createPrismaPasswordStore(prisma, { sessions: store }),
      audit,
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  tenantId = tenant.id;
  const client = await prisma.client.create({
    data: {
      clientId: 'app-a',
      name: 'App A',
      type: 'web',
      redirectUris: ['https://app-a.example.com/callback'],
      postLogoutRedirectUris: [],
      allowedOrigins: [],
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      tenantId,
    },
  });
  clientId = client.id;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await redis?.quit();
  await redisContainer?.stop();
  await prisma?.$disconnect();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

describe('account profile', () => {
  it('returns only the signed-in user public profile', async () => {
    const userId = await createUser('profile-user');
    const session = await createSession(userId);

    const response = await request(app.server)
      .get('/api/v1/account/profile')
      .set('Cookie', cookie(session));

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      id: userId,
      username: 'profile-user',
      email: 'profile-user@example.com',
      status: 'active',
      emailVerified: true,
      mustChangePassword: false,
    });
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    expect(JSON.stringify(response.body)).not.toContain(userPassword);
  });

  it('rejects a request without an IdP session cookie', async () => {
    const response = await request(app.server).get('/api/v1/account/profile');

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ status: 401, code: 'login_required' });
  });

  it('rejects a session whose account was disabled', async () => {
    const userId = await createUser('disabled-user');
    const session = await createSession(userId);
    await prisma.user.update({ where: { id: userId }, data: { status: 'disabled' } });

    const response = await request(app.server)
      .get('/api/v1/account/profile')
      .set('Cookie', cookie(session));

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('account_unavailable');
  });
});

describe('account password change', () => {
  it('rejects a cross-origin or non-JSON mutation', async () => {
    const userId = await createUser('csrf-user');
    const session = await createSession(userId);

    const noOrigin = await request(app.server)
      .put('/api/v1/account/password')
      .set('Cookie', cookie(session))
      .send({ currentPassword: userPassword, newPassword: 'brand-new-password-456' });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.code).toBe('cross_origin_request');

    const crossOrigin = await request(app.server)
      .put('/api/v1/account/password')
      .set('Cookie', cookie(session))
      .set('Origin', 'https://evil.example')
      .send({ currentPassword: userPassword, newPassword: 'brand-new-password-456' });
    expect(crossOrigin.status).toBe(403);

    const wrongContentType = await request(app.server)
      .put('/api/v1/account/password')
      .set('Cookie', cookie(session))
      .set('Origin', issuer)
      .set('Content-Type', 'text/plain')
      .send(
        JSON.stringify({ currentPassword: userPassword, newPassword: 'brand-new-password-456' }),
      );
    expect(wrongContentType.status).toBe(403);
  });

  it('rejects a wrong current password and audits the failure without secrets', async () => {
    const userId = await createUser('wrong-current');
    const session = await createSession(userId);

    const response = await request(app.server)
      .put('/api/v1/account/password')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ currentPassword: 'not-the-password', newPassword: 'brand-new-password-456' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_current_password');

    const audit = await prisma.auditEvent.findFirst({
      where: { targetId: userId, action: 'user.password.change_failed' },
    });
    expect(audit?.result).toBe('failure');
    expect(JSON.stringify(audit?.metadata)).not.toContain('not-the-password');
    expect(JSON.stringify(audit?.metadata)).not.toContain(userPassword);
  });

  it('applies the password policy and returns machine-readable violations', async () => {
    const userId = await createUser('policy-user');
    const session = await createSession(userId);

    const response = await request(app.server)
      .put('/api/v1/account/password')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ currentPassword: userPassword, newPassword: 'short' });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'password_policy',
      violations: ['too_short'],
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await verifyPassword(user.passwordHash ?? '', userPassword, FAST_ARGON2)).toBe(true);
  });

  it('keeps the current session and revokes every other session and refresh token', async () => {
    const userId = await createUser('rotate-user');
    const current = await createSession(userId);
    const other = await createSession(userId);
    const currentRefresh = await createRefreshToken(userId, current.sid);
    const otherRefresh = await createRefreshToken(userId, other.sid);

    const response = await request(app.server)
      .put('/api/v1/account/password')
      .set('Cookie', cookie(current))
      .set(sameOrigin)
      .send({ currentPassword: userPassword, newPassword: 'brand-new-password-456' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      keptCurrentSession: true,
      revokedSessions: 1,
      revokedRefreshTokens: 1,
    });

    // Redis is what authorize/token read.
    await expect(store.read(current.sid)).resolves.not.toBeNull();
    await expect(store.read(other.sid)).resolves.toBeNull();

    const sessions = await prisma.session.findMany({ where: { userId } });
    const kept = sessions.find((row) => row.id === current.sid);
    const revoked = sessions.find((row) => row.id === other.sid);
    expect(kept?.revokedAt).toBeNull();
    expect(revoked?.revokedAt).not.toBeNull();
    expect(revoked?.revokeReason).toBe('password_change');

    const tokens = await prisma.refreshToken.findMany({ where: { userId } });
    expect(tokens.find((row) => row.id === currentRefresh)?.revokedAt).toBeNull();
    expect(tokens.find((row) => row.id === otherRefresh)?.revokedAt).not.toBeNull();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(
      await verifyPassword(user.passwordHash ?? '', 'brand-new-password-456', FAST_ARGON2),
    ).toBe(true);
    expect(user.mustChangePassword).toBe(false);

    const audit = await prisma.auditEvent.findFirst({
      where: { targetId: userId, action: 'user.password.changed' },
    });
    expect(audit?.result).toBe('success');
    expect(audit?.metadata).toMatchObject({ keptCurrentSession: true });
    expect(JSON.stringify(audit?.metadata)).not.toContain('brand-new-password-456');
    expect(JSON.stringify(audit?.metadata)).not.toContain(userPassword);
  });
});

describe('account sessions', () => {
  it('lists only the caller sessions and marks the current one', async () => {
    const userId = await createUser('list-own');
    const otherUserId = await createUser('list-other');
    const current = await createSession(userId);
    const second = await createSession(userId);
    const foreign = await createSession(otherUserId);

    const response = await request(app.server)
      .get('/api/v1/account/sessions')
      .set('Cookie', cookie(current));

    expect(response.status).toBe(200);
    const ids = (response.body.items as { id: string }[]).map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([current.sid, second.sid]));
    expect(ids).not.toContain(foreign.sid);
    expect(response.body.total).toBe(2);
    expect(
      (response.body.items as { id: string; current: boolean }[]).find(
        (item) => item.id === current.sid,
      )?.current,
    ).toBe(true);
    expect(
      (response.body.items as { id: string; current: boolean }[]).find(
        (item) => item.id === second.sid,
      )?.current,
    ).toBe(false);
  });

  it('closes another session of the caller and audits it', async () => {
    const userId = await createUser('close-own');
    const current = await createSession(userId);
    const other = await createSession(userId);
    const refresh = await createRefreshToken(userId, other.sid);

    const response = await request(app.server)
      .delete(`/api/v1/account/sessions/${other.sid}`)
      .set('Cookie', cookie(current))
      .set(sameOrigin);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ revoked: true, alreadyRevoked: false });
    await expect(store.read(other.sid)).resolves.toBeNull();
    const row = await prisma.session.findUniqueOrThrow({ where: { id: other.sid } });
    expect(row.revokeReason).toBe('user_revoked');
    const token = await prisma.refreshToken.findUniqueOrThrow({ where: { id: refresh } });
    expect(token.revokedAt).not.toBeNull();

    const audit = await prisma.auditEvent.findFirst({
      where: { targetId: other.sid, action: 'session.revoke' },
    });
    expect(audit).toMatchObject({ actorType: 'user', actorId: userId, result: 'success' });
  });

  it('never closes a session owned by another user', async () => {
    const userId = await createUser('close-foreign');
    const otherUserId = await createUser('close-victim');
    const current = await createSession(userId);
    const foreign = await createSession(otherUserId);

    const response = await request(app.server)
      .delete(`/api/v1/account/sessions/${foreign.sid}`)
      .set('Cookie', cookie(current))
      .set(sameOrigin);

    expect(response.status).toBe(404);
    await expect(store.read(foreign.sid)).resolves.not.toBeNull();
  });

  it('refuses to close the current session from the list', async () => {
    const userId = await createUser('close-current');
    const current = await createSession(userId);

    const response = await request(app.server)
      .delete(`/api/v1/account/sessions/${current.sid}`)
      .set('Cookie', cookie(current))
      .set(sameOrigin);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('current_session');
    await expect(store.read(current.sid)).resolves.not.toBeNull();
  });

  it('rejects a cross-origin session close', async () => {
    const userId = await createUser('close-csrf');
    const current = await createSession(userId);
    const other = await createSession(userId);

    const response = await request(app.server)
      .delete(`/api/v1/account/sessions/${other.sid}`)
      .set('Cookie', cookie(current))
      .set('Origin', 'https://evil.example');

    expect(response.status).toBe(403);
    await expect(store.read(other.sid)).resolves.not.toBeNull();
  });
});
