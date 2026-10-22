import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaEffectiveAccessSource } from '../src/oidc/effective-access.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let prisma: PrismaClient;
let user: { id: string };
let source: ReturnType<typeof createPrismaEffectiveAccessSource>;
let defaultMembershipId: string;
let contextMembershipId: string;
let membershipGatedContextKey: string;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionStringValue },
  });
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_access_${Date.now()}`;
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
  source = createPrismaEffectiveAccessSource(prisma, () => new Date('2026-10-19T12:00:00Z'));

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  const makeClient = (clientId: string, scopes: string[]) =>
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
  const appA = await makeClient('app-a', ['openid']);
  const appB = await makeClient('app-b', ['openid']);
  const adminPanel = await makeClient('admin-panel', ['openid', 'idp.admin']);

  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: 'admin',
      email: 'admin@example.com',
      displayName: 'Admin',
      status: 'active',
    },
  });
  user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: 'ali',
      email: 'ali@example.com',
      displayName: 'Ali',
      status: 'active',
    },
  });

  const permission = (key: string, clientId: string | null) =>
    prisma.permission.create({ data: { key, description: key, clientId } });
  const contactRead = await permission('app-a:contact:read', appA.id);
  const contactWrite = await permission('app-a:contact:write', appA.id);
  const reportExport = await permission('app-a:report:export', appA.id);
  const secretRead = await permission('app-b:secret:read', appB.id);
  const userRead = await permission('idp:user:read', null);
  const memberRead = await permission('idp:member:read', null);

  const role = (
    key: string,
    clientId: string | null,
    permissions: { id: string }[],
    isDefault = false,
  ) =>
    prisma.role.create({
      data: {
        key,
        name: key,
        description: key,
        clientId,
        isDefault,
        rolePermissions: { create: permissions.map((entry) => ({ permissionId: entry.id })) },
      },
    });

  const memberRole = await role('app-a:member', appA.id, [contactRead], true);
  const editorRole = await role('app-a:editor', appA.id, [contactWrite]);
  const expiredRole = await role('app-a:expired', appA.id, [reportExport]);
  const appBAdmin = await role('app-b:admin', appB.id, [secretRead]);
  const superadmin = await role('idp:superadmin', null, [userRead, memberRead]);

  const context = (key: string, allowedRoles: string[], isDefault = false) =>
    prisma.clientLoginContext.create({
      data: {
        clientId: appA.id,
        key,
        name: key,
        allowedRoles,
        defaultRoles: [],
        loginMethods: ['password'],
        sessionIdleTtl: 1800,
        sessionAbsoluteTtl: 28800,
        isDefault,
      },
    });
  const customerContext = await context('customer-admin', ['app-a:editor'], true);
  await context('empty-context', []);
  membershipGatedContextKey = 'membership-gated';
  await context(membershipGatedContextKey, ['app-a:editor']);

  const membership = (clientId: string, loginContextId: string | null, status = 'active') =>
    prisma.clientMembership.create({
      data: {
        clientId,
        userId: user.id,
        loginContextId,
        status: status as 'active',
        attributes: { department: 'sales' },
        invitedBy: admin.id,
      },
    });
  defaultMembershipId = (await membership(appA.id, null)).id;
  contextMembershipId = (await membership(appA.id, customerContext.id)).id;
  await membership(appB.id, null);

  const assign = (roleId: string, expiresAt: Date | null = null) =>
    prisma.assignment.create({
      data: {
        subjectType: 'user',
        subjectId: user.id,
        roleId,
        scopeType: 'global',
        assignedBy: admin.id,
        expiresAt,
      },
    });
  await assign(memberRole.id);
  await assign(editorRole.id);
  await assign(expiredRole.id, new Date('2026-10-18T12:00:00Z'));
  await assign(appBAdmin.id);
  await assign(superadmin.id);

  void adminPanel;
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

describe('effective access', () => {
  it('returns only the app roles and permissions, without idp:* data', async () => {
    const access = await source.resolve({ userId: user.id, clientId: 'app-a' });
    expect(access.roles).toEqual(['app-a:editor', 'app-a:member']);
    expect(access.permissions).toEqual(['app-a:contact:read', 'app-a:contact:write']);
    expect(access.membership).toEqual({
      context: null,
      status: 'active',
      attributes: { department: 'sales' },
    });
  });

  it('never includes another app data', async () => {
    const forA = await source.resolve({ userId: user.id, clientId: 'app-a' });
    const forB = await source.resolve({ userId: user.id, clientId: 'app-b' });

    expect(forB.roles).toEqual(['app-b:admin']);
    expect(forB.permissions).toEqual(['app-b:secret:read']);
    expect(forA.roles).not.toContain('app-b:admin');
    expect(forA.permissions).not.toContain('app-b:secret:read');
    expect(forB.roles).not.toContain('app-a:member');
  });

  it('ignores expired assignments', async () => {
    const access = await source.resolve({ userId: user.id, clientId: 'app-a' });
    expect(access.roles).not.toContain('app-a:expired');
    expect(access.permissions).not.toContain('app-a:report:export');
  });

  it('narrows roles to the allowed roles of a login context', async () => {
    const access = await source.resolve({
      userId: user.id,
      clientId: 'app-a',
      loginContext: 'customer-admin',
    });
    expect(access.roles).toEqual(['app-a:editor']);
    expect(access.permissions).toEqual(['app-a:contact:write']);
    expect(access.membership?.context).toBe('customer-admin');
  });

  it('returns no access for a context without allowed roles', async () => {
    const access = await source.resolve({
      userId: user.id,
      clientId: 'app-a',
      loginContext: 'empty-context',
    });
    expect(access.roles).toEqual([]);
    expect(access.permissions).toEqual([]);
  });

  it('returns no access for a context without a membership, even when roles match', async () => {
    const access = await source.resolve({
      userId: user.id,
      clientId: 'app-a',
      loginContext: membershipGatedContextKey,
    });
    expect(access.roles).toEqual([]);
    expect(access.permissions).toEqual([]);
    expect(access.membership).toBeNull();
  });

  it('returns no access when the context membership is suspended', async () => {
    await prisma.clientMembership.update({
      where: { id: contextMembershipId },
      data: { status: 'suspended' },
    });
    try {
      const access = await source.resolve({
        userId: user.id,
        clientId: 'app-a',
        loginContext: 'customer-admin',
      });
      expect(access.roles).toEqual([]);
      expect(access.permissions).toEqual([]);
      expect(access.membership?.status).toBe('suspended');
    } finally {
      await prisma.clientMembership.update({
        where: { id: contextMembershipId },
        data: { status: 'active' },
      });
    }
  });

  it('returns no access for an unknown context', async () => {
    await expect(
      source.resolve({ userId: user.id, clientId: 'app-a', loginContext: 'ghost' }),
    ).resolves.toEqual({ roles: [], permissions: [], membership: null });
  });

  it('keeps idp:* claims for the admin panel client', async () => {
    const access = await source.resolve({ userId: user.id, clientId: 'admin-panel' });
    expect(access.roles).toContain('idp:superadmin');
    expect(access.permissions).toEqual(['idp:member:read', 'idp:user:read']);
  });

  it('withdraws roles and permissions when the membership is suspended', async () => {
    await prisma.clientMembership.update({
      where: { id: defaultMembershipId },
      data: { status: 'suspended' },
    });
    const access = await source.resolve({ userId: user.id, clientId: 'app-a' });
    expect(access.roles).toEqual([]);
    expect(access.permissions).toEqual([]);
    expect(access.membership?.status).toBe('suspended');
  });

  it('returns nothing for an unknown client', async () => {
    await expect(source.resolve({ userId: user.id, clientId: 'ghost' })).resolves.toEqual({
      roles: [],
      permissions: [],
      membership: null,
    });
  });
});
