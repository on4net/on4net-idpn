import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaMemberRepository } from '../src/admin/members/prisma-member-repository.js';
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

const MEMBER_PERMISSIONS = [
  'idp:client-member:read',
  'idp:client-member:invite',
  'idp:client-member:write',
  'idp:client-role:assign',
  'idp:client-session:read',
];

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let prisma: PrismaClient;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let adminUserId: string;
let delegatedAId: string;
let appAId: string;
let appBId: string;
let memberUserId: string;

const connectionString = (): string => connectionStringValue;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

async function sign(
  userId: string,
  clientId: string,
  scope: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const accessToken = await keys.signAccessToken(
    { scope, client_id: clientId, auth_time: nowSeconds(), ...extra },
    { issuer, audience: clientId, subject: userId, expiresInSeconds: 300 },
  );
  return 'Bearer ' + accessToken;
}

const globalAuth = () => sign(adminUserId, adminClientId, 'openid idp.admin');
const delegatedAuth = () => sign(delegatedAId, 'app-a', 'openid idp.client-admin');

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_members_${Date.now()}`;
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

  const rbac = createPrismaRbacRepository(prisma);
  app = buildServer({
    issuer,
    keys,
    rbac: {
      adminClientId,
      permissions: createPrismaPermissionReader(prisma),
      rbac,
      audit: createPrismaAdminAudit(prisma),
    },
    adminMembers: {
      adminClientId,
      permissions: createPrismaPermissionReader(prisma),
      members: createPrismaMemberRepository(prisma, { rbac }),
      audit: createPrismaAdminAudit(prisma),
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  const makeClient = (clientId: string, membershipSchema: unknown = null) =>
    prisma.client.create({
      data: {
        clientId,
        name: clientId,
        type: 'web',
        redirectUris: [],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes: ['openid', 'idp.client-admin'],
        membershipSchema: membershipSchema as never,
        tenantId: tenant.id,
      },
    });
  await makeClient(adminClientId);
  const appA = await makeClient('app-a', {
    type: 'object',
    properties: { department: { type: 'string' } },
    required: ['department'],
    additionalProperties: false,
  });
  const appB = await makeClient('app-b');
  appAId = appA.id;
  appBId = appB.id;

  const permissionRows = new Map<string, string>();
  for (const key of MEMBER_PERMISSIONS) {
    const row = await prisma.permission.create({ data: { key, description: key } });
    permissionRows.set(key, row.id);
  }
  const delegatedPermissions = MEMBER_PERMISSIONS.map((key) => ({
    permissionId: permissionRows.get(key)!,
  }));
  const adminRole = await prisma.role.create({
    data: {
      key: 'membership-admin',
      name: 'Membership admin',
      description: 'testing',
      rolePermissions: { create: delegatedPermissions },
    },
  });
  const delegatedRole = await prisma.role.create({
    data: {
      key: 'app-a:user-admin',
      name: 'App A user admin',
      description: 'delegated',
      clientId: appAId,
      rolePermissions: { create: delegatedPermissions },
    },
  });
  const defaultRole = await prisma.role.create({
    data: {
      key: 'app-a:member',
      name: 'Member',
      description: 'default',
      clientId: appAId,
      isDefault: true,
    },
  });
  const editorRole = await prisma.role.create({
    data: {
      key: 'app-a:editor',
      name: 'Editor',
      description: 'editor',
      clientId: appAId,
    },
  });
  const appBRole = await prisma.role.create({
    data: {
      key: 'app-b:member',
      name: 'App B member',
      description: 'member',
      clientId: appBId,
    },
  });
  const globalRole = await prisma.role.create({
    data: { key: 'idp:support', name: 'Support', description: 'global support' },
  });
  void defaultRole;
  void editorRole;
  void appBRole;

  const makeUser = (username: string, status: 'active' | 'pending' = 'active') =>
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        username,
        email: `${username}@example.com`,
        displayName: username,
        status,
      },
    });
  const admin = await makeUser('admin');
  const delegated = await makeUser('delegated-a');
  const member = await makeUser('member');
  adminUserId = admin.id;
  delegatedAId = delegated.id;
  memberUserId = member.id;

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
        subjectId: delegated.id,
        roleId: delegatedRole.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
      {
        subjectType: 'user',
        subjectId: member.id,
        roleId: globalRole.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
    ],
  });

  void defaultRole;
  void editorRole;
  void appBRole;
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

describe('membership invite', () => {
  it('invites an existing user with explicit roles and default roles', async () => {
    const response = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', await globalAuth())
      .send({
        email: 'member@example.com',
        roleKeys: ['app-a:editor'],
        attributes: { department: 'sales' },
      })
      .expect(201);

    expect(response.body.createdUser).toBe(false);
    expect(response.body.member).toMatchObject({
      userId: memberUserId,
      status: 'invited',
      attributes: { department: 'sales' },
    });
    expect(response.body.member.roleKeys).toEqual(['app-a:editor', 'app-a:member']);
  });

  it('rejects a duplicate membership with 409', async () => {
    const response = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', await globalAuth())
      .send({ email: 'member@example.com', attributes: { department: 'sales' } })
      .expect(409);
    expect(response.body.type).toContain('/conflict');
  });

  it('creates a pending user when the email is unknown', async () => {
    const response = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', await globalAuth())
      .send({
        email: 'newcomer@example.com',
        displayName: 'New Comer',
        attributes: { department: 'support' },
      })
      .expect(201);

    expect(response.body.createdUser).toBe(true);
    const created = await prisma.user.findUniqueOrThrow({
      where: { id: response.body.member.userId as string },
    });
    expect(created).toMatchObject({ status: 'pending', displayName: 'New Comer' });
    expect(created.passwordHash).toBeNull();
  });

  it('rejects attributes that violate the client schema', async () => {
    const missing = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', await globalAuth())
      .send({ email: 'invalid@example.com', attributes: {} })
      .expect(422);
    expect(missing.body.detail).toContain('department is required');

    const extra = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', await globalAuth())
      .send({ email: 'invalid@example.com', attributes: { department: 'x', extra: 1 } })
      .expect(422);
    expect(extra.body.detail).toContain('extra is not allowed');
  });

  it('rejects roles of another client', async () => {
    const response = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', await globalAuth())
      .send({
        email: 'foreign-role@example.com',
        roleKeys: ['app-b:member'],
        attributes: { department: 'sales' },
      })
      .expect(422);
    expect(response.body.detail).toContain('do not belong to client "app-a"');
    await expect(
      prisma.user.findFirst({ where: { email: 'foreign-role@example.com' } }),
    ).resolves.toBeNull();
  });
});

describe('membership lifecycle', () => {
  it('activates and suspends a membership, revoking only that app refresh tokens', async () => {
    const session = await prisma.session.create({
      data: {
        userId: memberUserId,
        idleExpiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 7_200_000),
        amr: ['pwd'],
        acr: 'urn:on4net:acr:pwd',
      },
    });
    const makeToken = (clientId: string) =>
      prisma.refreshToken.create({
        data: {
          tokenHash: randomUUID().replace(/-/g, '').padEnd(64, 'a'),
          familyId: randomUUID(),
          clientId,
          userId: memberUserId,
          sessionId: session.id,
          scope: ['openid'],
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    const appAToken = await makeToken(appAId);
    const appBToken = await makeToken(appBId);

    const activated = await request(app.server)
      .patch(`/api/v1/clients/app-a/members/${memberUserId}`)
      .set('Authorization', await globalAuth())
      .send({ status: 'active' })
      .expect(200);
    expect(activated.body.joinedAt).toEqual(expect.any(String));

    const suspended = await request(app.server)
      .patch(`/api/v1/clients/app-a/members/${memberUserId}`)
      .set('Authorization', await globalAuth())
      .send({ status: 'suspended' })
      .expect(200);
    expect(suspended.body.status).toBe('suspended');

    const [afterA, afterB] = await Promise.all([
      prisma.refreshToken.findUniqueOrThrow({ where: { id: appAToken.id } }),
      prisma.refreshToken.findUniqueOrThrow({ where: { id: appBToken.id } }),
    ]);
    expect(afterA.revokedAt).not.toBeNull();
    expect(afterB.revokedAt).toBeNull();
  });

  it('replaces only the client roles and keeps global assignments', async () => {
    const response = await request(app.server)
      .put(`/api/v1/clients/app-a/members/${memberUserId}/roles`)
      .set('Authorization', await globalAuth())
      .send({ roleKeys: ['app-a:editor'] })
      .expect(200);
    expect(response.body.roleKeys).toEqual(['app-a:editor']);

    const globalRoles = await prisma.assignment.findMany({
      where: { subjectType: 'user', subjectId: memberUserId, role: { clientId: null } },
    });
    expect(globalRoles.length).toBeGreaterThan(0);
  });

  it('lists only the sessions of that client', async () => {
    const appASession = await prisma.session.create({
      data: {
        userId: memberUserId,
        clientId: appAId,
        idleExpiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 7_200_000),
        amr: ['pwd'],
        acr: 'urn:on4net:acr:pwd',
      },
    });
    await prisma.session.create({
      data: {
        userId: memberUserId,
        clientId: appBId,
        idleExpiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 7_200_000),
        amr: ['pwd'],
        acr: 'urn:on4net:acr:pwd',
      },
    });

    const response = await request(app.server)
      .get(`/api/v1/clients/app-a/members/${memberUserId}/sessions`)
      .set('Authorization', await globalAuth())
      .expect(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].id).toBe(appASession.id);
  });

  it('removes the membership without deleting the user', async () => {
    await request(app.server)
      .delete(`/api/v1/clients/app-a/members/${memberUserId}`)
      .set('Authorization', await globalAuth())
      .expect(204);

    await expect(prisma.user.findUnique({ where: { id: memberUserId } })).resolves.not.toBeNull();
    const memberships = await prisma.clientMembership.count({
      where: { clientId: appAId, userId: memberUserId },
    });
    expect(memberships).toBe(0);
  });
});

describe('delegated membership administration', () => {
  it('reads only members of its own client', async () => {
    const response = await request(app.server)
      .get('/api/v1/clients/app-a/members')
      .set('Authorization', await delegatedAuth())
      .expect(200);
    expect(response.body.items).toEqual(expect.any(Array));
  });

  it('cannot reach another client', async () => {
    await request(app.server)
      .get('/api/v1/clients/app-b/members')
      .set('Authorization', await delegatedAuth())
      .expect(403);

    await request(app.server)
      .post('/api/v1/clients/app-b/members/invite')
      .set('Authorization', await delegatedAuth())
      .send({ email: 'someone@example.com', attributes: {} })
      .expect(403);
  });

  it('requires a fresh authentication to replace roles', async () => {
    const stale = await sign(delegatedAId, 'app-a', 'openid idp.client-admin', {
      auth_time: nowSeconds() - 3_600,
    });
    await request(app.server)
      .put(`/api/v1/clients/app-a/members/${memberUserId}/roles`)
      .set('Authorization', stale)
      .send({ roleKeys: [] })
      .expect(403);
  });
});
