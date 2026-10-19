import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaRbacRepository } from '../src/admin/rbac/prisma-rbac-repository.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { buildServer } from '../src/server.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3100';
const adminClientId = 'admin-panel';
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let prisma: PrismaClient;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let adminUserId: string;
let delegatedAId: string;
let delegatedBId: string;
let regularUserId: string;
let appARoleId: string;
let appBRoleId: string;

const connectionString = (): string => connectionStringValue;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

async function tokenFor(
  userId: string,
  clientId: string,
  scope = 'openid idp.client-admin',
): Promise<string> {
  const accessToken = await keys.signAccessToken(
    { scope, client_id: clientId, auth_time: nowSeconds() },
    { issuer, audience: clientId, subject: userId, expiresInSeconds: 300 },
  );
  return 'Bearer ' + accessToken;
}

const globalAuthorization = async (): Promise<{ Authorization: string }> => {
  const accessToken = await keys.signAccessToken(
    { scope: 'openid idp.admin', client_id: adminClientId, auth_time: nowSeconds() },
    { issuer, audience: adminClientId, subject: adminUserId, expiresInSeconds: 300 },
  );
  return { Authorization: 'Bearer ' + accessToken };
};

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_delegated_${Date.now()}`;
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

  const permissions = createPrismaPermissionReader(prisma, () => new Date());
  app = buildServer({
    issuer,
    keys,
    rbac: {
      adminClientId,
      permissions,
      rbac: createPrismaRbacRepository(prisma),
      audit: createPrismaAdminAudit(prisma),
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  const newClient = (clientId: string, scopes: string[]) =>
    prisma.client.create({
      data: {
        clientId,
        name: clientId,
        type: 'web',
        redirectUris: [],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes,
        tenantId: tenant.id,
      },
    });
  await newClient(adminClientId, ['openid', 'idp.admin']);
  const appA = await newClient('app-a', ['openid', 'idp.client-admin']);
  const appB = await newClient('app-b', ['openid', 'idp.client-admin']);

  const permissionKeys = [
    'idp:role:read',
    'idp:role:write',
    'idp:client-role:read',
    'idp:client-role:write',
    'idp:user:read',
    'app-a:contact:read',
    'app-b:contact:read',
  ];
  const permissionRows = new Map<string, string>();
  for (const key of permissionKeys) {
    const clientId = key.startsWith('app-a:') ? appA.id : key.startsWith('app-b:') ? appB.id : null;
    const row = await prisma.permission.create({
      data: { key, description: key, clientId },
    });
    permissionRows.set(key, row.id);
  }

  const adminRole = await prisma.role.create({
    data: {
      key: 'catalog-admin',
      name: 'Catalog admin',
      description: 'global catalog',
      rolePermissions: {
        create: ['idp:role:read', 'idp:role:write'].map((key) => ({
          permissionId: permissionRows.get(key)!,
        })),
      },
    },
  });
  const appAAdmin = await prisma.role.create({
    data: {
      key: 'app-a:user-admin',
      name: 'App A user admin',
      description: 'delegated admin',
      clientId: appA.id,
      rolePermissions: {
        create: ['idp:client-role:read', 'idp:client-role:write'].map((key) => ({
          permissionId: permissionRows.get(key)!,
        })),
      },
    },
  });
  const appBAdmin = await prisma.role.create({
    data: {
      key: 'app-b:user-admin',
      name: 'App B user admin',
      description: 'delegated admin',
      clientId: appB.id,
      rolePermissions: {
        create: ['idp:client-role:read', 'idp:client-role:write'].map((key) => ({
          permissionId: permissionRows.get(key)!,
        })),
      },
    },
  });
  const appARole = await prisma.role.create({
    data: {
      key: 'app-a:member',
      name: 'App A member',
      description: 'member',
      clientId: appA.id,
      isDefault: true,
    },
  });
  const appBRole = await prisma.role.create({
    data: {
      key: 'app-b:member',
      name: 'App B member',
      description: 'member',
      clientId: appB.id,
      isDefault: true,
    },
  });
  appARoleId = appARole.id;
  appBRoleId = appBRole.id;

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
  const delegatedA = await makeUser('delegated-a');
  const delegatedB = await makeUser('delegated-b');
  const regular = await makeUser('regular');
  adminUserId = admin.id;
  delegatedAId = delegatedA.id;
  delegatedBId = delegatedB.id;
  regularUserId = regular.id;

  await prisma.assignment.createMany({
    data: [
      {
        subjectType: 'user',
        subjectId: admin.id,
        roleId: adminRole.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
      {
        subjectType: 'user',
        subjectId: delegatedA.id,
        roleId: appAAdmin.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
      {
        subjectType: 'user',
        subjectId: delegatedB.id,
        roleId: appBAdmin.id,
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

describe('delegated admin token', () => {
  it('is accepted for its own client and scoped reads are limited to it', async () => {
    const response = await request(app.server)
      .get('/api/v1/permissions')
      .set('Authorization', await tokenFor(delegatedAId, 'app-a'))
      .expect(200);

    const keys = response.body.items.map((item: { key: string }) => item.key);
    expect(keys).toContain('app-a:contact:read');
    expect(keys).not.toContain('app-b:contact:read');
    expect(keys).not.toContain('idp:user:read');
  });

  it('cannot ask for another client through a query parameter', async () => {
    const response = await request(app.server)
      .get('/api/v1/permissions?clientId=app-b')
      .set('Authorization', await tokenFor(delegatedAId, 'app-a'))
      .expect(403);
    expect(response.body.type).toContain('/forbidden');
  });

  it('cannot create a permission for another client', async () => {
    await request(app.server)
      .post('/api/v1/permissions')
      .set('Authorization', await tokenFor(delegatedAId, 'app-a'))
      .send({ key: 'app-b:invoice:read', clientId: 'app-b', description: 'cross-client' })
      .expect(403);

    await expect(
      prisma.permission.findUnique({ where: { key: 'app-b:invoice:read' } }),
    ).resolves.toBeNull();
  });

  it('can manage its own catalog', async () => {
    const created = await request(app.server)
      .post('/api/v1/permissions')
      .set('Authorization', await tokenFor(delegatedAId, 'app-a'))
      .send({ key: 'app-a:invoice:read', clientId: 'app-a', description: 'invoices' })
      .expect(201);
    expect(created.body.clientId).toBe('app-a');

    const role = await request(app.server)
      .post('/api/v1/roles')
      .set('Authorization', await tokenFor(delegatedAId, 'app-a'))
      .send({
        key: 'app-a:billing',
        name: 'Billing',
        clientId: 'app-a',
        permissions: ['app-a:invoice:read'],
      })
      .expect(201);
    expect(role.body.permissionKeys).toEqual(['app-a:invoice:read']);
  });

  it('cannot link a global permission to one of its roles', async () => {
    const response = await request(app.server)
      .post('/api/v1/roles')
      .set('Authorization', await tokenFor(delegatedAId, 'app-a'))
      .send({
        key: 'app-a:privileged',
        name: 'Privileged',
        clientId: 'app-a',
        permissions: ['idp:user:read'],
      })
      .expect(422);
    expect(response.body.detail).toContain('does not belong');
  });

  it('cannot read or delete a role of another client', async () => {
    await request(app.server)
      .get(`/api/v1/roles/${appBRoleId}`)
      .set('Authorization', await tokenFor(delegatedAId, 'app-a'))
      .expect(403);

    await request(app.server)
      .delete(`/api/v1/roles/${appBRoleId}`)
      .set('Authorization', await tokenFor(delegatedAId, 'app-a'))
      .expect(403);

    await expect(prisma.role.findUnique({ where: { id: appBRoleId } })).resolves.not.toBeNull();
  });

  it('lists only the roles of its own client', async () => {
    const response = await request(app.server)
      .get('/api/v1/roles')
      .set('Authorization', await tokenFor(delegatedBId, 'app-b'))
      .expect(200);
    const keys = response.body.items.map((item: { key: string }) => item.key);
    expect(keys).toContain('app-b:member');
    expect(keys).not.toContain('app-a:member');
  });

  it('rejects a delegated token without idp.client-admin', async () => {
    await request(app.server)
      .get('/api/v1/roles')
      .set('Authorization', await tokenFor(delegatedAId, 'app-a', 'openid idp.admin'))
      .expect(403);
  });

  it('rejects a user who holds no scoped permission', async () => {
    await request(app.server)
      .get('/api/v1/roles')
      .set('Authorization', await tokenFor(regularUserId, 'app-a'))
      .expect(403);
  });

  it('keeps the global admin able to act on any client', async () => {
    const response = await request(app.server)
      .get(`/api/v1/roles/${appBRoleId}`)
      .set(await globalAuthorization())
      .expect(200);
    expect(response.body.key).toBe('app-b:member');
  });

  it('still requires a recent authentication for step-up operations', async () => {
    const stale = await keys.signAccessToken(
      { scope: 'openid idp.client-admin', client_id: 'app-a', auth_time: nowSeconds() - 3_600 },
      { issuer, audience: 'app-a', subject: delegatedAId, expiresInSeconds: 300 },
    );
    const response = await request(app.server)
      .delete(`/api/v1/roles/${appARoleId}`)
      .set('Authorization', 'Bearer ' + stale)
      .expect(403);
    expect(response.body.type).toContain('/forbidden');
  });
});

describe('scoped permission reader', () => {
  it('returns only idp:client-* permissions of the requested app', async () => {
    const reader = createPrismaPermissionReader(prisma);
    const forA = await reader.clientPermissionsForUser!(delegatedAId, 'app-a');
    expect(forA).toContain('idp:client-role:read');
    expect(forA).not.toContain('idp:role:read');

    await expect(reader.clientPermissionsForUser!(delegatedAId, 'app-b')).resolves.toEqual([]);
  });
});
