import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authenticateClient } from '../src/oidc/client-auth.js';
import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaAdminClientRepository } from '../src/admin/clients/prisma-client-repository.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaPublicConfigRepository } from '../src/public-config/prisma-repository.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { createPrismaClientRepository } from '../src/oidc/prisma-client-repository.js';
import { buildServer } from '../src/server.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3100';
const adminClientId = 'admin-panel';

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let prisma: PrismaClient;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let adminUserId: string;
let readerUserId: string;

const connectionString = (): string => connectionStringValue;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

const token = async (userId: string, scope = 'openid idp.admin') =>
  `Bearer ${await keys.signAccessToken(
    { scope, client_id: adminClientId },
    { issuer, audience: adminClientId, subject: userId, expiresInSeconds: 300 },
  )}`;

const createClientBody = (overrides: Record<string, unknown> = {}) => ({
  clientId: 'app-a',
  name: 'App A',
  type: 'web',
  redirectUris: ['https://app-a.example.com/auth/callback'],
  postLogoutRedirectUris: ['https://app-a.example.com/'],
  allowedOrigins: ['https://app-a.example.com'],
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  ...overrides,
});

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_clients_${Date.now()}`;
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

  keys = new SigningKeyManager(new MemorySigningKeyRepository());
  await keys.ensureKey();

  app = buildServer({
    issuer,
    keys,
    publicConfig: {
      repository: createPrismaPublicConfigRepository(prisma),
      originLookup: async () => ['https://app-a.example.com'],
      mfe: { version: '1.0.0', remoteEntry: 'https://cdn.example.com/1.0.0/remoteEntry.js' },
    },
    adminClients: {
      adminClientId,
      permissions: createPrismaPermissionReader(prisma),
      clients: createPrismaAdminClientRepository(prisma),
      audit: createPrismaAdminAudit(prisma),
      now: () => new Date('2026-10-19T09:00:00Z'),
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  await prisma.client.create({
    data: {
      clientId: adminClientId,
      name: 'Admin',
      type: 'web',
      redirectUris: ['http://127.0.0.1:3001/auth/callback'],
      postLogoutRedirectUris: [],
      allowedOrigins: [],
      scopes: ['openid', 'idp.admin', 'idp.client-read', 'idp.client-write'],
      tenantId: tenant.id,
    },
  });

  const permissionKeys = ['idp:client:read', 'idp:client:write'];
  const permissions = await Promise.all(
    permissionKeys.map((key) => prisma.permission.create({ data: { key, description: key } })),
  );
  const full = await prisma.role.create({
    data: {
      key: 'client-admin',
      name: 'Client admin',
      description: 'client management',
      rolePermissions: {
        create: permissions.map((permission) => ({ permissionId: permission.id })),
      },
    },
  });
  const readOnly = await prisma.role.create({
    data: {
      key: 'client-reader',
      name: 'Client reader',
      description: 'read only',
      rolePermissions: {
        create: permissions
          .filter((permission) => permission.key === 'idp:client:read')
          .map((permission) => ({ permissionId: permission.id })),
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
      },
    });

  const admin = await makeUser('admin');
  const reader = await makeUser('reader');
  adminUserId = admin.id;
  readerUserId = reader.id;

  await prisma.assignment.createMany({
    data: [
      {
        subjectType: 'user',
        subjectId: admin.id,
        roleId: full.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
      {
        subjectType: 'user',
        subjectId: reader.id,
        roleId: readOnly.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
    ],
  });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

describe('client administration authorization', () => {
  it('requires a token', async () => {
    await request(app.server).get('/api/v1/clients').expect(401);
  });

  it('returns 403 without the write permission', async () => {
    const response = await request(app.server)
      .post('/api/v1/clients')
      .set('Authorization', await token(readerUserId))
      .send(createClientBody())
      .expect(403);
    expect(response.body.type).toContain('/forbidden');
    await expect(prisma.client.findUnique({ where: { clientId: 'app-a' } })).resolves.toBeNull();
  });
});

describe('client CRUD and redirect validation', () => {
  it('creates a client and returns the secret exactly once', async () => {
    const response = await request(app.server)
      .post('/api/v1/clients')
      .set('Authorization', await token(adminUserId))
      .send(createClientBody())
      .expect(201);

    expect(response.body.client).toMatchObject({
      clientId: 'app-a',
      status: 'active',
      type: 'web',
    });
    expect(typeof response.body.clientSecret).toBe('string');
    expect(JSON.stringify(response.body.client)).not.toContain(response.body.clientSecret);

    const detail = await request(app.server)
      .get('/api/v1/clients/app-a')
      .set('Authorization', await token(adminUserId))
      .expect(200);
    expect(detail.body.secrets).toHaveLength(1);
    expect(JSON.stringify(detail.body)).not.toContain(response.body.clientSecret);
    expect(detail.body.secrets[0].prefix).toHaveLength(12);

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'client.create', targetType: 'client' },
    });
    expect(audit).toMatchObject({ actorType: 'admin', actorId: adminUserId });
    expect(JSON.stringify(audit?.metadata)).not.toContain(response.body.clientSecret);
  });

  it('rejects an unregistered or unsafe redirect URI', async () => {
    const wildcard = await request(app.server)
      .post('/api/v1/clients')
      .set('Authorization', await token(adminUserId))
      .send(createClientBody({ clientId: 'app-b', redirectUris: ['https://app-b.example.com/*'] }))
      .expect(422);
    expect(wildcard.body.detail).toContain('wildcards are not allowed');

    const plainHttp = await request(app.server)
      .post('/api/v1/clients')
      .set('Authorization', await token(adminUserId))
      .send({
        clientId: 'app-c',
        name: 'App C',
        type: 'web',
        redirectUris: ['http://app-c.example.com/cb'],
        scopes: ['openid'],
      })
      .expect(422);
    expect(plainHttp.body.detail).toContain('must use https');

    expect(await prisma.client.findUnique({ where: { clientId: 'app-b' } })).toBeNull();
    expect(await prisma.client.findUnique({ where: { clientId: 'app-c' } })).toBeNull();
  });

  it('rejects the same client twice and the admin scope for another client', async () => {
    await request(app.server)
      .post('/api/v1/clients')
      .set('Authorization', await token(adminUserId))
      .send(createClientBody())
      .expect(409);

    const reserved = await request(app.server)
      .post('/api/v1/clients')
      .set('Authorization', await token(adminUserId))
      .send(createClientBody({ clientId: 'app-d', scopes: ['openid', 'idp.admin'] }))
      .expect(422);
    expect(reserved.body.detail).toContain('idp.admin is reserved');
  });

  it('updates branding, MFE features and membership schema', async () => {
    const response = await request(app.server)
      .patch('/api/v1/clients/app-a')
      .set('Authorization', await token(adminUserId))
      .send({
        branding: { primaryColor: '#0f766e', logoUrl: 'https://app-a.example.com/logo.svg' },
        mfeFeatures: { userManagement: true, mfa: false },
        membershipSchema: { type: 'object', properties: { department: { type: 'string' } } },
        accessTokenTtl: 300,
      });
    expect(response.status).toBe(200);

    expect(response.body).toMatchObject({
      branding: { primaryColor: '#0f766e' },
      mfeFeatures: { userManagement: true, mfa: false },
      accessTokenTtl: 300,
    });
    expect(response.body.membershipSchema).toMatchObject({ type: 'object' });

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'client.update' },
    });
    expect(audit?.metadata).toMatchObject({
      fields: ['accessTokenTtl', 'branding', 'membershipSchema', 'mfeFeatures'],
    });
  });

  it('rejects an invalid branding key and a non-object membership schema', async () => {
    await request(app.server)
      .patch('/api/v1/clients/app-a')
      .set('Authorization', await token(adminUserId))
      .send({ branding: { evil: 'x' } })
      .expect(422);

    await request(app.server)
      .patch('/api/v1/clients/app-a')
      .set('Authorization', await token(adminUserId))
      .send({ membershipSchema: { type: 'array' } })
      .expect(422);
  });

  it('lists clients with search and pagination', async () => {
    const response = await request(app.server)
      .get('/api/v1/clients?q=app-a&status=active&limit=10')
      .set('Authorization', await token(adminUserId))
      .expect(200);
    expect(response.body).toMatchObject({ page: 1, limit: 10 });
    expect(response.body.items.map((item: { clientId: string }) => item.clientId)).toEqual([
      'app-a',
    ]);
  });
});

describe('client secrets', () => {
  it('rotates a secret, keeps the previous one valid until revoked, then revokes it', async () => {
    const first = await request(app.server)
      .post('/api/v1/clients/app-a/secrets')
      .set('Authorization', await token(adminUserId))
      .send({})
      .expect(201);
    expect(typeof first.body.clientSecret).toBe('string');
    expect(first.body.secret.id).toBeTruthy();

    const second = await request(app.server)
      .post('/api/v1/clients/app-a/secrets')
      .set('Authorization', await token(adminUserId))
      .send({})
      .expect(201);
    expect(second.body.clientSecret).not.toBe(first.body.clientSecret);

    const detail = await request(app.server)
      .get('/api/v1/clients/app-a')
      .set('Authorization', await token(adminUserId))
      .expect(200);
    expect(detail.body.secrets.length).toBeGreaterThanOrEqual(3);

    // Both rotated secrets authenticate until one is revoked.
    const authRepository = createPrismaClientRepository(prisma);
    await expect(
      authenticateClient(authRepository, {
        clientId: 'app-a',
        clientSecret: second.body.clientSecret,
        method: 'client_secret_basic',
      }),
    ).resolves.toMatchObject({ ok: true });

    await request(app.server)
      .delete(`/api/v1/clients/app-a/secrets/${first.body.secret.id}`)
      .set('Authorization', await token(adminUserId))
      .expect(204);

    await expect(
      authenticateClient(authRepository, {
        clientId: 'app-a',
        clientSecret: first.body.clientSecret,
        method: 'client_secret_basic',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_client_secret' });

    await request(app.server)
      .delete(`/api/v1/clients/app-a/secrets/${first.body.secret.id}`)
      .set('Authorization', await token(adminUserId))
      .expect(404);

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'client.secret.create' },
    });
    expect(JSON.stringify(audit?.metadata)).toContain('prefix');
    expect(JSON.stringify(audit?.metadata)).not.toContain(second.body.clientSecret);
  });

  it('refuses to issue a secret for a public client', async () => {
    await request(app.server)
      .post('/api/v1/clients')
      .set('Authorization', await token(adminUserId))
      .send({
        clientId: 'spa-app',
        name: 'SPA',
        type: 'spa',
        redirectUris: ['https://spa.example.com/cb'],
        scopes: ['openid'],
      })
      .expect(201);

    const response = await request(app.server)
      .post('/api/v1/clients/spa-app/secrets')
      .set('Authorization', await token(adminUserId))
      .send({})
      .expect(409);
    expect(response.body.detail).toContain('do not hold a client secret');
  });
});

describe('public config never leaks secrets', () => {
  it('serves the client configuration without any secret material', async () => {
    const response = await request(app.server)
      .get('/api/v1/clients/app-a/public-config')
      .set('Origin', 'https://app-a.example.com')
      .expect(200);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('clientSecret');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('redirectUris');
    expect(serialized).not.toContain('secrets');
    expect(response.body).toMatchObject({ clientId: 'app-a' });
  });
});

describe('client disable', () => {
  it('disables the client, revokes its tokens and blocks authorization', async () => {
    const client = await prisma.client.findUniqueOrThrow({ where: { clientId: 'app-a' } });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: adminUserId } });
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        clientId: client.id,
        idleExpiresAt: new Date('2030-01-01T00:00:00Z'),
        absoluteExpiresAt: new Date('2030-01-02T00:00:00Z'),
        amr: ['pwd'],
        acr: 'urn:on4net:acr:pwd',
      },
    });
    await prisma.refreshToken.create({
      data: {
        clientId: client.id,
        userId: user.id,
        sessionId: session.id,
        tokenHash: 'hash-of-a-token',
        familyId: randomUUID(),
        scope: ['openid'],
        expiresAt: new Date('2030-01-01T00:00:00Z'),
      },
    });

    const response = await request(app.server)
      .post('/api/v1/clients/app-a/disable')
      .set('Authorization', await token(adminUserId))
      .expect(200);

    expect(response.body.client.status).toBe('disabled');
    expect(response.body.revokedSessions).toBe(1);
    expect(response.body.revokedRefreshTokens).toBe(1);

    const storedSession = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(storedSession.revokedAt).not.toBeNull();
    expect(storedSession.revokeReason).toBe('client_disabled');

    const authRepository = createPrismaClientRepository(prisma);
    await expect(authRepository.findForAuth('app-a')).resolves.toMatchObject({
      status: 'disabled',
    });

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'client.disable' },
    });
    expect(audit?.metadata).toMatchObject({ revokedSessions: 1 });
  });
});
