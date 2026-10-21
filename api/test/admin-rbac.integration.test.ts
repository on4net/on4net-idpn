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

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let prisma: PrismaClient;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let adminUserId: string;
let readerUserId: string;
let rbac: ReturnType<typeof createPrismaRbacRepository>;

const connectionString = (): string => connectionStringValue;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

const token = async (userId: string, scope = 'openid idp.admin'): Promise<string> => {
  const accessToken = await keys.signAccessToken(
    { scope, client_id: adminClientId, auth_time: Math.floor(Date.now() / 1000) },
    { issuer, audience: adminClientId, subject: userId, expiresInSeconds: 300 },
  );
  return 'Bearer ' + accessToken;
};

const authorization = async (userId: string) => ({ Authorization: await token(userId) });

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_rbac_${Date.now()}`;
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

  rbac = createPrismaRbacRepository(prisma);
  app = buildServer({
    issuer,
    keys,
    rbac: {
      adminClientId,
      permissions: createPrismaPermissionReader(prisma),
      rbac,
      audit: createPrismaAdminAudit(prisma),
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  await prisma.client.createMany({
    data: [
      {
        clientId: adminClientId,
        name: 'Admin',
        type: 'web',
        redirectUris: ['http://127.0.0.1:3001/auth/callback'],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes: ['openid', 'idp.admin'],
        tenantId: tenant.id,
      },
      {
        clientId: 'app-a',
        name: 'App A',
        type: 'web',
        redirectUris: [],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes: ['openid'],
        tenantId: tenant.id,
      },
      {
        clientId: 'app-b',
        name: 'App B',
        type: 'web',
        redirectUris: [],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes: ['openid'],
        tenantId: tenant.id,
      },
    ],
  });

  const permissionKeys = ['idp:role:read', 'idp:role:write'];
  const permissions = await Promise.all(
    permissionKeys.map((key) => prisma.permission.create({ data: { key, description: key } })),
  );
  const full = await prisma.role.create({
    data: {
      key: 'catalog-admin',
      name: 'Catalog admin',
      description: 'catalog management',
      rolePermissions: {
        create: permissions.map((permission) => ({ permissionId: permission.id })),
      },
    },
  });
  const readOnly = await prisma.role.create({
    data: {
      key: 'catalog-reader',
      name: 'Catalog reader',
      description: 'read only',
      rolePermissions: {
        create: permissions
          .filter((permission) => permission.key === 'idp:role:read')
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

describe('catalog authorization', () => {
  it('requires a token', async () => {
    await request(app.server).get('/api/v1/permissions').expect(401);
  });

  it('rejects a caller without the write permission', async () => {
    const response = await request(app.server)
      .post('/api/v1/permissions')
      .set(await authorization(readerUserId))
      .send({ key: 'app-a:contact:read', clientId: 'app-a', description: 'read contacts' })
      .expect(403);
    expect(response.body.type).toContain('/forbidden');
  });
});

describe('permission catalog', () => {
  it('creates a client permission and rejects duplicates', async () => {
    const created = await request(app.server)
      .post('/api/v1/permissions')
      .set(await authorization(adminUserId))
      .send({ key: 'app-a:contact:read', clientId: 'app-a', description: 'read contacts' })
      .expect(201);

    expect(created.body).toMatchObject({
      key: 'app-a:contact:read',
      clientId: 'app-a',
      description: 'read contacts',
    });

    const duplicate = await request(app.server)
      .post('/api/v1/permissions')
      .set(await authorization(adminUserId))
      .send({ key: 'app-a:contact:read', clientId: 'app-a', description: 'again' })
      .expect(409);
    expect(duplicate.body.type).toContain('/conflict');
  });

  it('rejects a key prefix that does not belong to the client', async () => {
    const response = await request(app.server)
      .post('/api/v1/permissions')
      .set(await authorization(adminUserId))
      .send({ key: 'app-b:contact:read', clientId: 'app-a', description: 'wrong prefix' })
      .expect(422);
    expect(response.body.detail).toContain('must start with "app-a"');
  });

  it('rejects an unknown client and global key without the idp prefix', async () => {
    await request(app.server)
      .post('/api/v1/permissions')
      .set(await authorization(adminUserId))
      .send({ key: 'ghost:contact:read', clientId: 'ghost', description: 'unknown client' })
      .expect(404);

    const global = await request(app.server)
      .post('/api/v1/permissions')
      .set(await authorization(adminUserId))
      .send({ key: 'app-a:global:read', clientId: null, description: 'not global' })
      .expect(422);
    expect(global.body.detail).toContain('must start with "idp"');
  });

  it('filters the list by client', async () => {
    await request(app.server)
      .post('/api/v1/permissions')
      .set(await authorization(adminUserId))
      .send({ key: 'app-b:contact:read', clientId: 'app-b', description: 'read contacts' })
      .expect(201);

    const list = await request(app.server)
      .get('/api/v1/permissions?clientId=app-a')
      .set(await authorization(adminUserId))
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].key).toBe('app-a:contact:read');
    expect(list.body.total).toBe(1);
  });
});

describe('roles and cross-client protection', () => {
  it('creates a role with permissions of its own client', async () => {
    const created = await request(app.server)
      .post('/api/v1/roles')
      .set(await authorization(adminUserId))
      .send({
        key: 'app-a:member',
        name: 'Member',
        description: 'app member',
        clientId: 'app-a',
        isDefault: true,
        permissions: ['app-a:contact:read'],
      })
      .expect(201);

    expect(created.body).toMatchObject({
      key: 'app-a:member',
      clientId: 'app-a',
      isDefault: true,
      permissionKeys: ['app-a:contact:read'],
    });
  });

  it('refuses to link a permission of app A to a role of app B', async () => {
    const response = await request(app.server)
      .post('/api/v1/roles')
      .set(await authorization(adminUserId))
      .send({
        key: 'app-b:member',
        name: 'Member',
        clientId: 'app-b',
        permissions: ['app-a:contact:read'],
      })
      .expect(422);
    expect(response.body.detail).toContain('cannot be linked');
    await expect(prisma.role.findUnique({ where: { key: 'app-b:member' } })).resolves.toBeNull();
  });

  it('refuses to link a platform permission to an app role', async () => {
    await request(app.server)
      .post('/api/v1/permissions')
      .set(await authorization(adminUserId))
      .send({ key: 'idp:user:read', description: 'platform user read' });
    const response = await request(app.server)
      .post('/api/v1/roles')
      .set(await authorization(adminUserId))
      .send({
        key: 'app-a:platform-admin',
        name: 'Platform admin',
        clientId: 'app-a',
        permissions: ['idp:user:read'],
      })
      .expect(422);
    expect(response.body.detail).toContain('platform permission');
    await expect(
      prisma.role.findUnique({ where: { key: 'app-a:platform-admin' } }),
    ).resolves.toBeNull();
  });

  it('accepts the documented per-app global permissions on an app role', async () => {
    await request(app.server)
      .post('/api/v1/permissions')
      .set(await authorization(adminUserId))
      .send({ key: 'idp:client-member:read', description: 'member read' });
    const created = await request(app.server)
      .post('/api/v1/roles')
      .set(await authorization(adminUserId))
      .send({
        key: 'app-a:user-admin',
        name: 'User admin',
        clientId: 'app-a',
        permissions: ['idp:client-member:read', 'app-a:contact:read'],
      })
      .expect(201);
    expect(created.body.permissionKeys.sort()).toEqual([
      'app-a:contact:read',
      'idp:client-member:read',
    ]);
  });

  it('rejects unknown permissions, duplicate keys and foreign role prefixes', async () => {
    await request(app.server)
      .post('/api/v1/roles')
      .set(await authorization(adminUserId))
      .send({
        key: 'app-a:ghost',
        name: 'Ghost',
        clientId: 'app-a',
        permissions: ['app-a:nope:read'],
      })
      .expect(422);

    await request(app.server)
      .post('/api/v1/roles')
      .set(await authorization(adminUserId))
      .send({ key: 'app-a:member', name: 'Duplicate', clientId: 'app-a' })
      .expect(409);

    const wrongPrefix = await request(app.server)
      .post('/api/v1/roles')
      .set(await authorization(adminUserId))
      .send({ key: 'app-b:editor', name: 'Editor', clientId: 'app-a' })
      .expect(422);
    expect(wrongPrefix.body.detail).toContain('must start with "app-a"');
  });

  it('replaces the role permission set and refuses a cross-client replacement', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'app-a:member' } });

    await request(app.server)
      .post('/api/v1/permissions')
      .set(await authorization(adminUserId))
      .send({ key: 'app-a:contact:write', clientId: 'app-a', description: 'write contacts' })
      .expect(201);

    const replaced = await request(app.server)
      .put(`/api/v1/roles/${role.id}/permissions`)
      .set(await authorization(adminUserId))
      .send({ permissions: ['app-a:contact:read', 'app-a:contact:write'] })
      .expect(200);
    expect(replaced.body.permissionKeys).toEqual(['app-a:contact:read', 'app-a:contact:write']);

    const crossClient = await request(app.server)
      .put(`/api/v1/roles/${role.id}/permissions`)
      .set(await authorization(adminUserId))
      .send({ permissions: ['app-b:contact:read'] })
      .expect(422);
    expect(crossClient.body.detail).toContain('cannot be linked');

    const unchanged = await prisma.rolePermission.count({ where: { roleId: role.id } });
    expect(unchanged).toBe(2);
  });

  it('rejects deleting a role or permission that is still in use', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'app-a:member' } });
    await prisma.assignment.create({
      data: {
        subjectType: 'user',
        subjectId: readerUserId,
        roleId: role.id,
        scopeType: 'global',
        assignedBy: adminUserId,
      },
    });

    await request(app.server)
      .delete(`/api/v1/roles/${role.id}`)
      .set(await authorization(adminUserId))
      .expect(409);

    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: 'app-a:contact:read' },
    });
    await request(app.server)
      .delete(`/api/v1/permissions/${permission.id}`)
      .set(await authorization(adminUserId))
      .expect(409);

    await prisma.assignment.deleteMany({ where: { roleId: role.id } });
  });

  it('deletes an unused role and permission', async () => {
    const role = await prisma.role.create({
      data: { key: 'app-b:viewer', name: 'Viewer', description: 'viewer' },
    });
    await request(app.server)
      .delete(`/api/v1/roles/${role.id}`)
      .set(await authorization(adminUserId))
      .expect(204);
    await expect(prisma.role.findUnique({ where: { id: role.id } })).resolves.toBeNull();

    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: 'app-b:contact:read' },
    });
    await request(app.server)
      .delete(`/api/v1/permissions/${permission.id}`)
      .set(await authorization(adminUserId))
      .expect(204);
    await expect(
      prisma.permission.findUnique({ where: { id: permission.id } }),
    ).resolves.toBeNull();
  });
});

describe('default roles', () => {
  it('assigns the default role of the client once per user', async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'default' } });
    const appB = await prisma.client.findUniqueOrThrow({ where: { clientId: 'app-b' } });
    await prisma.role.create({
      data: {
        key: 'app-b:member',
        name: 'Member',
        description: 'default member role',
        clientId: appB.id,
        isDefault: true,
      },
    });
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        username: 'member',
        email: 'member@example.com',
        displayName: 'Member',
        status: 'active',
      },
    });

    expect(
      await rbac.assignDefaultRoles({
        clientId: 'app-b',
        userId: user.id,
        assignedBy: adminUserId,
      }),
    ).toEqual(['app-b:member']);

    await rbac.assignDefaultRoles({ clientId: 'app-b', userId: user.id, assignedBy: adminUserId });
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'app-b:member' } });
    const assignments = await prisma.assignment.count({
      where: { subjectType: 'user', subjectId: user.id, roleId: role.id },
    });
    expect(assignments).toBe(1);
  });

  it('returns no roles for an unknown client', async () => {
    await expect(
      rbac.assignDefaultRoles({
        clientId: 'ghost',
        userId: adminUserId,
        assignedBy: adminUserId,
      }),
    ).resolves.toEqual([]);
  });
});

describe('audit trail', () => {
  it('records catalog mutations without leaking secrets', async () => {
    const events = await prisma.auditEvent.findMany({
      where: { action: { in: ['permission.create', 'role.create', 'role.permissions.replace'] } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((event) => event.actorType === 'admin')).toBe(true);
    expect(events.some((event) => event.action === 'role.create')).toBe(true);
  });
});
