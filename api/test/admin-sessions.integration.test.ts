import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaAdminSessionRepository } from '../src/admin/sessions/prisma-session-repository.js';
import { createPrismaAdminUserRepository } from '../src/admin/prisma-user-repository.js';
import { createPrismaMemberRepository } from '../src/admin/members/prisma-member-repository.js';
import { createPrismaPasswordStore } from '../src/audit/prisma-audit.js';
import { hashPassword, type Argon2Params } from '../src/auth/password.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { s256Challenge } from '../src/oidc/authorization-code.js';
import { createPrismaClientRepository } from '../src/oidc/prisma-client-repository.js';
import { createPrismaCodeRepository } from '../src/oidc/prisma-code-repository.js';
import { createPrismaRefreshTokenRepository } from '../src/oidc/prisma-refresh-repository.js';
import { createPrismaUserRepository } from '../src/oidc/prisma-user-repository.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { buildServer } from '../src/server.js';
import { createPrismaSessionRevocationHook } from '../src/session/prisma-revocation.js';
import { RedisSessionCache } from '../src/session/redis-cache.js';
import { RedisSessionStore } from '../src/session/store.js';
import type { IdpSession } from '../src/session/types.js';
import { changePassword } from '../src/users/change-password.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3100';
const adminClientId = 'admin-panel';
const userPassword = 'correct-horse-battery';
const FAST_ARGON2: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const REDIRECT_URI = 'https://app-a.example.com/callback';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';

let container: StartedPostgreSqlContainer | undefined;
let redisContainer: StartedRedisContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let redis: Redis;
let prisma: PrismaClient;
let keys: SigningKeyManager;
let store: RedisSessionStore;
let app: ReturnType<typeof buildServer>;

let globalAdminId: string;
let appAAdminId: string;
let memberAId: string;
let memberBId: string;
let multiUserId: string;
let outsiderId: string;

const connectionString = (): string => connectionStringValue;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

async function accessToken(
  userId: string,
  clientId: string,
  scope = 'openid idp.admin',
): Promise<string> {
  const token = await keys.signAccessToken(
    { scope, client_id: clientId },
    { issuer, audience: clientId, subject: userId, expiresInSeconds: 300 },
  );
  return `Bearer ${token}`;
}

const globalAuth = (): Promise<string> => accessToken(globalAdminId, adminClientId);
const delegatedAuth = (userId: string, clientId = 'app-a'): Promise<string> =>
  accessToken(userId, clientId, 'openid idp.client-admin');

async function createSession(
  userId: string,
  client: { id: string; clientId: string } | null,
): Promise<IdpSession> {
  const session = await store.create({
    userId,
    ...(client === null ? {} : { clientId: client.clientId }),
    amr: ['pwd'],
    acr: 'urn:on4net:acr:pwd',
    ip: '10.0.0.1',
    userAgent: 'vitest-agent',
  });
  await prisma.session.create({
    data: {
      id: session.sid,
      userId,
      clientId: client?.id ?? null,
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

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_sessions_${Date.now()}`;
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

  keys = new SigningKeyManager(new MemorySigningKeyRepository());
  await keys.ensureKey();

  const permissions = createPrismaPermissionReader(prisma);
  const audit = createPrismaAdminAudit(prisma);
  const users = createPrismaAdminUserRepository(prisma);
  const members = createPrismaMemberRepository(prisma, { sessions: store });
  const clients = createPrismaClientRepository(prisma);

  app = buildServer({
    issuer,
    keys,
    token: {
      clients,
      codes: createPrismaCodeRepository(prisma),
      refreshTokens: createPrismaRefreshTokenRepository(prisma),
      users: createPrismaUserRepository(prisma),
      sessions: store,
    },
    authorize: { clients, isConsentGranted: async () => true },
    admin: { adminClientId, permissions, users, audit, sessions: store },
    adminMembers: { adminClientId, permissions, members, audit },
    adminSessions: {
      adminClientId,
      permissions,
      repository: createPrismaAdminSessionRepository(prisma),
      revoker: store,
      audit,
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  const clientRows = new Map<string, { id: string; clientId: string }>();
  for (const [clientId, scopes, redirectUris] of [
    [adminClientId, ['openid', 'idp.admin'], ['https://admin.example.com/cb']],
    ['app-a', ['openid', 'profile', 'idp.client-admin'], [REDIRECT_URI]],
    ['app-b', ['openid', 'profile', 'idp.client-admin'], ['https://app-b.example.com/callback']],
  ] as const) {
    const row = await prisma.client.create({
      data: {
        clientId,
        name: clientId,
        type: 'web',
        redirectUris: [...redirectUris],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes: [...scopes],
        tenantId: tenant.id,
      },
    });
    clientRows.set(clientId, { id: row.id, clientId: row.clientId });
  }
  const appA = clientRows.get('app-a')!;
  const appB = clientRows.get('app-b')!;

  const permissionKeys = [
    'idp:user:read',
    'idp:user:write',
    'idp:session:read',
    'idp:session:write',
    'idp:client-session:read',
    'idp:client-session:write',
    'idp:client-member:read',
    'idp:client-member:write',
  ];
  const permissionRows = new Map<string, string>();
  for (const key of permissionKeys) {
    const row = await prisma.permission.create({ data: { key, description: key } });
    permissionRows.set(key, row.id);
  }

  const globalRole = await prisma.role.create({
    data: {
      key: 'sessions-global',
      name: 'Sessions global',
      description: 'global session admin',
      rolePermissions: {
        create: ['idp:user:read', 'idp:user:write', 'idp:session:read', 'idp:session:write'].map(
          (key) => ({ permissionId: permissionRows.get(key)! }),
        ),
      },
    },
  });
  const appARole = await prisma.role.create({
    data: {
      key: 'app-a:sessions-admin',
      name: 'App A sessions admin',
      description: 'delegated',
      clientId: appA.id,
      rolePermissions: {
        create: [
          'idp:client-session:read',
          'idp:client-session:write',
          'idp:client-member:read',
          'idp:client-member:write',
        ].map((key) => ({ permissionId: permissionRows.get(key)! })),
      },
    },
  });
  await prisma.role.create({
    data: {
      key: 'app-b:sessions-admin',
      name: 'App B sessions admin',
      description: 'delegated',
      clientId: appB.id,
      rolePermissions: {
        create: ['idp:client-session:read', 'idp:client-session:write'].map((key) => ({
          permissionId: permissionRows.get(key)!,
        })),
      },
    },
  });

  const makeUser = async (username: string) =>
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        username,
        email: `${username}@example.com`,
        displayName: username,
        status: 'active',
        passwordHash: await hashPassword(userPassword, FAST_ARGON2),
      },
    });
  const [globalAdmin, appAAdmin, memberA, memberB, multiUser, outsider] = await Promise.all([
    makeUser('sessions-admin'),
    makeUser('app-a-admin'),
    makeUser('member-a'),
    makeUser('member-b'),
    makeUser('multi-user'),
    makeUser('outsider'),
  ]);
  globalAdminId = globalAdmin.id;
  appAAdminId = appAAdmin.id;
  memberAId = memberA.id;
  memberBId = memberB.id;
  multiUserId = multiUser.id;
  outsiderId = outsider.id;

  await prisma.assignment.createMany({
    data: [
      {
        subjectType: 'user',
        subjectId: globalAdmin.id,
        roleId: globalRole.id,
        scopeType: 'global',
        assignedBy: globalAdmin.id,
      },
      {
        subjectType: 'user',
        subjectId: appAAdmin.id,
        roleId: appARole.id,
        scopeType: 'global',
        assignedBy: globalAdmin.id,
      },
    ],
  });
  await prisma.clientMembership.createMany({
    data: [
      { clientId: appA.id, userId: memberA.id, status: 'active', joinedAt: new Date() },
      { clientId: appB.id, userId: memberB.id, status: 'active', joinedAt: new Date() },
      { clientId: appA.id, userId: multiUser.id, status: 'active', joinedAt: new Date() },
      { clientId: appB.id, userId: multiUser.id, status: 'active', joinedAt: new Date() },
    ],
  });

  appAId = appA.id;
  appBId = appB.id;
}, 300_000);

let appAId: string;
let appBId: string;

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

describe('GET /api/v1/sessions (global)', () => {
  it('filters by user/client/status and returns status, created, lastSeen, ip and acr', async () => {
    const session = await createSession(memberAId, { id: appAId, clientId: 'app-a' });
    const response = await request(app.server)
      .get(`/api/v1/sessions?userId=${memberAId}`)
      .set('Authorization', await globalAuth())
      .expect(200);

    expect(response.body).toMatchObject({ page: 1, limit: 25 });
    const listed = response.body.items.find((item: { id: string }) => item.id === session.sid);
    expect(listed).toMatchObject({
      userId: memberAId,
      clientId: 'app-a',
      status: 'active',
      ip: '10.0.0.1',
      userAgent: 'vitest-agent',
      acr: 'urn:on4net:acr:pwd',
      amr: ['pwd'],
      revokedAt: null,
    });
    expect(typeof listed.createdAt).toBe('string');
    expect(typeof listed.lastSeenAt).toBe('string');
    expect(JSON.stringify(response.body)).not.toContain('Bearer');

    await request(app.server)
      .get(`/api/v1/sessions?userId=${memberAId}&clientId=app-b`)
      .set('Authorization', await globalAuth())
      .expect(200)
      .expect((res) => {
        expect(res.body.items).toHaveLength(0);
      });

    await request(app.server)
      .get('/api/v1/sessions?limit=1000')
      .set('Authorization', await globalAuth())
      .expect(422);
  });
});

describe('self-service session endpoints', () => {
  it('lists and closes only the caller sessions', async () => {
    const own = await createSession(appAAdminId, { id: appAId, clientId: 'app-a' });
    const foreign = await createSession(memberAId, { id: appAId, clientId: 'app-a' });

    const listed = await request(app.server)
      .get('/api/v1/me/sessions')
      .set('Authorization', await delegatedAuth(appAAdminId))
      .expect(200);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toContain(own.sid);
    expect(listed.body.items.map((item: { id: string }) => item.id)).not.toContain(foreign.sid);

    await request(app.server)
      .delete(`/api/v1/me/sessions/${foreign.sid}`)
      .set('Authorization', await delegatedAuth(appAAdminId))
      .expect(404);
    await expect(store.read(foreign.sid)).resolves.not.toBeNull();
    const foreignRow = await prisma.session.findUniqueOrThrow({ where: { id: foreign.sid } });
    expect(foreignRow.revokedAt).toBeNull();

    await request(app.server)
      .delete(`/api/v1/me/sessions/${own.sid}`)
      .set('Authorization', await delegatedAuth(appAAdminId))
      .expect(200);
    await expect(store.read(own.sid)).resolves.toBeNull();
    const ownRow = await prisma.session.findUniqueOrThrow({ where: { id: own.sid } });
    expect(ownRow.revokedAt).not.toBeNull();

    const after = await request(app.server)
      .get('/api/v1/me/sessions')
      .set('Authorization', await delegatedAuth(appAAdminId))
      .expect(200);
    expect(after.body.items.map((item: { id: string }) => item.id)).not.toContain(own.sid);
  });
});

describe('delegated session scoping', () => {
  it('lists only its own app and only current members', async () => {
    const appAMember = await createSession(memberAId, { id: appAId, clientId: 'app-a' });
    const appBOnly = await createSession(memberBId, { id: appBId, clientId: 'app-b' });
    const adminNotMember = await createSession(appAAdminId, { id: appAId, clientId: 'app-a' });

    const response = await request(app.server)
      .get('/api/v1/sessions')
      .set('Authorization', await delegatedAuth(appAAdminId))
      .expect(200);

    const ids = response.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(appAMember.sid);
    expect(ids).not.toContain(appBOnly.sid);
    expect(ids).not.toContain(adminNotMember.sid);

    await request(app.server)
      .get('/api/v1/sessions?clientId=app-b')
      .set('Authorization', await delegatedAuth(appAAdminId))
      .expect(403);
  });

  it('rejects revoking another app or a non-member and revokes its own member', async () => {
    const appBSession = await createSession(memberBId, { id: appBId, clientId: 'app-b' });
    const outsiderSession = await createSession(outsiderId, { id: appAId, clientId: 'app-a' });
    const memberSession = await createSession(memberAId, { id: appAId, clientId: 'app-a' });

    await request(app.server)
      .delete(`/api/v1/sessions/${appBSession.sid}`)
      .set('Authorization', await delegatedAuth(appAAdminId))
      .expect(403);
    await expect(store.read(appBSession.sid)).resolves.not.toBeNull();

    await request(app.server)
      .delete(`/api/v1/sessions/${outsiderSession.sid}`)
      .set('Authorization', await delegatedAuth(appAAdminId))
      .expect(403);
    await expect(store.read(outsiderSession.sid)).resolves.not.toBeNull();

    await request(app.server)
      .delete(`/api/v1/sessions/${memberSession.sid}`)
      .set('Authorization', await delegatedAuth(appAAdminId))
      .expect(200);
    await expect(store.read(memberSession.sid)).resolves.toBeNull();

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'session.revoke', targetId: memberSession.sid },
    });
    expect(audit).toMatchObject({ actorType: 'admin', actorId: appAAdminId });
    expect(audit?.metadata).toMatchObject({ userId: memberAId });
    expect(JSON.stringify(audit?.metadata)).not.toContain('Bearer');
  });

  it('scopes logout-all to its own app and rejects non-members', async () => {
    const appA = await createSession(multiUserId, { id: appAId, clientId: 'app-a' });
    const appB = await createSession(multiUserId, { id: appBId, clientId: 'app-b' });

    await request(app.server)
      .post(`/api/v1/users/${memberBId}/logout-all`)
      .set('Authorization', await delegatedAuth(appAAdminId))
      .expect(403);

    const response = await request(app.server)
      .post(`/api/v1/users/${multiUserId}/logout-all`)
      .set('Authorization', await delegatedAuth(appAAdminId))
      .expect(200);
    expect(response.body.revoked).toBe(1);
    await expect(store.read(appA.sid)).resolves.toBeNull();
    await expect(store.read(appB.sid)).resolves.not.toBeNull();

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'session.logout_all', targetId: multiUserId },
    });
    expect(audit?.metadata).toMatchObject({ scope: 'app', revoked: 1 });

    // Global logout-all revokes what is left.
    const rest = await request(app.server)
      .post(`/api/v1/users/${multiUserId}/logout-all`)
      .set('Authorization', await globalAuth())
      .expect(200);
    expect(rest.body.revoked).toBe(1);
    await expect(store.read(appB.sid)).resolves.toBeNull();
  });
});

describe('concurrent session limit', () => {
  it('revokes the oldest session and mirrors the revocation with an audit event', async () => {
    const tenant = await prisma.tenant.findFirstOrThrow();
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        username: `limit-${Date.now()}`,
        email: `limit-${Date.now()}@example.com`,
        displayName: 'Limit target',
        status: 'active',
      },
    });
    let current = new Date('2099-01-01T00:00:00Z');
    const limited = new RedisSessionStore({
      cache: new RedisSessionCache(redis),
      policy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600, maxConcurrentSessions: 2 },
      onRevoked: createPrismaSessionRevocationHook(prisma),
      now: () => current,
    });

    const created: IdpSession[] = [];
    for (let index = 0; index < 3; index += 1) {
      current = new Date(current.getTime() + 60_000);
      const session = await limited.create({
        userId: user.id,
        amr: ['pwd'],
        acr: 'urn:on4net:acr:pwd',
      });
      await prisma.session.create({
        data: {
          id: session.sid,
          userId: user.id,
          createdAt: new Date(session.createdAt),
          lastSeenAt: new Date(session.lastSeenAt),
          idleExpiresAt: new Date(session.idleExpiresAt),
          absoluteExpiresAt: new Date(session.absoluteExpiresAt),
          amr: session.amr,
          acr: session.acr,
        },
      });
      created.push(session);
    }

    const [oldest, second, newest] = created;
    expect(oldest).toBeDefined();
    await expect(store.read(oldest!.sid)).resolves.toBeNull();
    await expect(store.read(second!.sid)).resolves.not.toBeNull();
    await expect(store.read(newest!.sid)).resolves.not.toBeNull();

    const mirrored = await prisma.session.findUniqueOrThrow({ where: { id: oldest!.sid } });
    expect(mirrored.revokeReason).toBe('concurrent_limit');
    expect(mirrored.revokedAt).not.toBeNull();

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'session.revoke', targetId: oldest!.sid },
    });
    expect(audit).toMatchObject({ actorType: 'system', result: 'success' });
    expect(audit?.metadata).toMatchObject({ userId: user.id, reason: 'concurrent_limit' });
  });
});

describe('revocation on account and membership actions', () => {
  it('disables a user and revokes the Redis session immediately', async () => {
    const target = await prisma.user.create({
      data: {
        tenantId: (await prisma.tenant.findFirstOrThrow()).id,
        username: `disable-${Date.now()}`,
        email: `disable-${Date.now()}@example.com`,
        displayName: 'Disable target',
        status: 'active',
      },
    });
    const session = await createSession(target.id, { id: appAId, clientId: 'app-a' });

    const response = await request(app.server)
      .post(`/api/v1/users/${target.id}/disable`)
      .set('Authorization', await globalAuth())
      .expect(200);
    expect(response.body.revokedSessions).toBe(1);

    await expect(store.read(session.sid)).resolves.toBeNull();
    const row = await prisma.session.findUniqueOrThrow({ where: { id: session.sid } });
    expect(row.revokeReason).toBe('admin_disabled');
  });

  it('suspends a membership and revokes only that app sessions', async () => {
    const user = await prisma.user.create({
      data: {
        tenantId: (await prisma.tenant.findFirstOrThrow()).id,
        username: `suspend-${Date.now()}`,
        email: `suspend-${Date.now()}@example.com`,
        displayName: 'Suspend target',
        status: 'active',
      },
    });
    await prisma.clientMembership.create({
      data: { clientId: appAId, userId: user.id, status: 'active', joinedAt: new Date() },
    });
    const appA = await createSession(user.id, { id: appAId, clientId: 'app-a' });
    const appB = await createSession(user.id, { id: appBId, clientId: 'app-b' });

    await request(app.server)
      .patch(`/api/v1/clients/app-a/members/${user.id}`)
      .set('Authorization', await delegatedAuth(appAAdminId))
      .send({ status: 'suspended' })
      .expect(200);

    await expect(store.read(appA.sid)).resolves.toBeNull();
    await expect(store.read(appB.sid)).resolves.not.toBeNull();
    const row = await prisma.session.findUniqueOrThrow({ where: { id: appA.sid } });
    expect(row.revokeReason).toBe('membership_suspend');
  });

  it('revokes Redis sessions on password change', async () => {
    const user = await prisma.user.create({
      data: {
        tenantId: (await prisma.tenant.findFirstOrThrow()).id,
        username: `password-${Date.now()}`,
        email: `password-${Date.now()}@example.com`,
        displayName: 'Password target',
        status: 'active',
        passwordHash: await hashPassword(userPassword, FAST_ARGON2),
      },
    });
    const session = await createSession(user.id, { id: appAId, clientId: 'app-a' });

    const result = await changePassword(
      createPrismaPasswordStore(prisma, { sessions: store }),
      (plain, params) => hashPassword(plain, params),
      {
        userId: user.id,
        currentPassword: userPassword,
        newPassword: 'a-brand-new-secret-1',
        params: FAST_ARGON2,
      },
    );

    expect(result).toMatchObject({ ok: true, revokedSessions: 1 });
    await expect(store.read(session.sid)).resolves.toBeNull();
  });

  it('makes the next authorize request fail after an admin revocation', async () => {
    const session = await createSession(memberAId, { id: appAId, clientId: 'app-a' });
    const query = {
      response_type: 'code',
      client_id: 'app-a',
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile',
      state: 'state-1',
      nonce: 'nonce-1',
      prompt: 'none',
      code_challenge: s256Challenge(verifier),
      code_challenge_method: 'S256',
    };

    const active = await request(app.server)
      .get('/oauth2/authorize')
      .query(query)
      .set('Cookie', `idpn_session=${session.sid}`)
      .expect(302);
    expect(active.headers.location).toContain('code=');

    await request(app.server)
      .delete(`/api/v1/sessions/${session.sid}`)
      .set('Authorization', await globalAuth())
      .expect(200);

    const revoked = await request(app.server)
      .get('/oauth2/authorize')
      .query(query)
      .set('Cookie', `idpn_session=${session.sid}`)
      .expect(302);
    const location = new URL(revoked.headers.location ?? '');
    expect(location.searchParams.get('error')).toBe('login_required');
  });
});
