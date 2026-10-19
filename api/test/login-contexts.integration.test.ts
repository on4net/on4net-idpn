import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaLoginContextRepository } from '../src/admin/login-contexts/prisma-login-context-repository.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { createPrismaPublicConfigRepository } from '../src/public-config/prisma-repository.js';
import { buildServer } from '../src/server.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3100';
const adminClientId = 'admin-panel';
const nowSeconds = (): number => Math.floor(Date.now() / 1000);
/** Older than the 300 second step-up window. */
const staleAuthTime = (): number => nowSeconds() - 3600;

const CONTEXT_PERMISSIONS = ['idp:client-context:read', 'idp:client-context:write'];

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let prisma: PrismaClient;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let adminUserId: string;
let delegatedUserId: string;
let appAId: string;
let appBId: string;

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

const globalAuth = (extra: Record<string, unknown> = {}) =>
  sign(adminUserId, adminClientId, 'openid idp.admin', extra);
const delegatedAuth = (extra: Record<string, unknown> = {}) =>
  sign(delegatedUserId, 'app-a', 'openid idp.client-admin', extra);

const api = () => request(app.server);

const contextBody = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  name: key,
  description: `${key} context`,
  allowedRoles: ['app-a:member', 'app-a:customer-admin'],
  defaultRoles: ['app-a:member'],
  loginMethods: ['password'],
  mfaPolicy: 'optional',
  registrationPolicy: 'invite_only',
  allowedEmailDomains: [],
  sessionIdleTtl: 900,
  sessionAbsoluteTtl: 28_800,
  stepUpRequired: false,
  isDefault: false,
  sortOrder: 0,
  ...overrides,
});

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_contexts_${Date.now()}`;
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

  const permissions = createPrismaPermissionReader(prisma);
  app = buildServer({
    issuer,
    keys,
    adminLoginContexts: {
      adminClientId,
      permissions,
      contexts: createPrismaLoginContextRepository(prisma),
      audit: createPrismaAdminAudit(prisma),
    },
    publicConfig: {
      repository: createPrismaPublicConfigRepository(prisma),
      originLookup: async () => [],
      mfe: {
        version: '1.0.0',
        remoteEntry: 'https://cdn.example.com/idpn-mfe/1.0.0/remoteEntry.js',
      },
    },
  });
  await app.ready();

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
  await makeClient(adminClientId, ['openid', 'idp.admin']);
  const appA = await makeClient('app-a', ['openid', 'idp.client-admin']);
  const appB = await makeClient('app-b', ['openid', 'idp.client-admin']);
  appAId = appA.id;
  appBId = appB.id;

  const permissionRows = new Map<string, string>();
  for (const key of CONTEXT_PERMISSIONS) {
    const row = await prisma.permission.create({ data: { key, description: key } });
    permissionRows.set(key, row.id);
  }
  const permissionLinks = CONTEXT_PERMISSIONS.map((key) => ({
    permissionId: permissionRows.get(key)!,
  }));
  const globalRole = await prisma.role.create({
    data: {
      key: 'context-admin',
      name: 'Context admin',
      description: 'global context administration',
      rolePermissions: { create: permissionLinks },
    },
  });
  const appARole = await prisma.role.create({
    data: {
      key: 'app-a:user-admin',
      name: 'App A user admin',
      description: 'delegated context administration',
      clientId: appAId,
      rolePermissions: { create: permissionLinks },
    },
  });

  for (const key of ['app-a:member', 'app-a:customer-admin', 'app-a:viewer']) {
    await prisma.role.create({
      data: { key, name: key, description: key, clientId: appAId },
    });
  }
  await prisma.role.create({
    data: { key: 'app-b:member', name: 'app-b member', description: 'other app', clientId: appBId },
  });
  await prisma.role.create({
    data: { key: 'idp:support', name: 'Support', description: 'global role' },
  });

  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: 'admin',
      email: 'admin@example.com',
      displayName: 'Admin',
      status: 'active',
    },
  });
  const delegated = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: 'app-admin',
      email: 'app-admin@example.com',
      displayName: 'App admin',
      status: 'active',
    },
  });
  adminUserId = admin.id;
  delegatedUserId = delegated.id;

  await prisma.assignment.create({
    data: {
      subjectType: 'user',
      subjectId: admin.id,
      roleId: globalRole.id,
      scopeType: 'global',
      assignedBy: admin.id,
    },
  });
  await prisma.assignment.create({
    data: {
      subjectType: 'user',
      subjectId: delegated.id,
      roleId: appARole.id,
      scopeType: 'global',
      assignedBy: admin.id,
    },
  });
});

beforeEach(async () => {
  await prisma.clientMembership.deleteMany({
    where: { clientId: { in: [appAId, appBId] } },
  });
  await prisma.clientLoginContext.deleteMany({
    where: { clientId: { in: [appAId, appBId] } },
  });
  await prisma.client.updateMany({
    where: { id: { in: [appAId, appBId] } },
    data: { defaultLoginContextKey: null },
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

describe('login context admin API', () => {
  it('creates, reads, lists, updates, disables and deletes a context', async () => {
    const created = await api()
      .post('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await globalAuth())
      .send(
        contextBody('customer-admin', {
          mfaPolicy: 'required_all',
          loginMethods: ['password', 'google'],
          stepUpRequired: true,
          sortOrder: 1,
        }),
      );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      key: 'customer-admin',
      status: 'active',
      // The first context of a client becomes its default.
      isDefault: true,
      mfaPolicy: 'required_all',
      loginMethods: ['password', 'google'],
    });
    const clientRow = await prisma.client.findUniqueOrThrow({
      where: { id: appAId },
      select: { defaultLoginContextKey: true },
    });
    expect(clientRow.defaultLoginContextKey).toBe('customer-admin');

    const list = await api()
      .get('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await globalAuth());
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.headers['cache-control']).toBe('no-store');

    const detail = await api()
      .get('/api/v1/clients/app-a/login-contexts/customer-admin')
      .set('Authorization', await globalAuth());
    expect(detail.status).toBe(200);
    expect(detail.body.key).toBe('customer-admin');

    const second = await api()
      .post('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await delegatedAuth())
      .send(contextBody('customer-team'));
    expect(second.status).toBe(201);
    expect(second.body.isDefault).toBe(false);

    const patched = await api()
      .patch('/api/v1/clients/app-a/login-contexts/customer-team')
      .set('Authorization', await globalAuth())
      .send({ name: 'Customer team', sortOrder: 5, stepUpRequired: true });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: 'Customer team', sortOrder: 5, isDefault: false });

    const disabled = await api()
      .post('/api/v1/clients/app-a/login-contexts/customer-team/disable')
      .set('Authorization', await globalAuth());
    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe('disabled');
    const kept = await prisma.clientLoginContext.findUniqueOrThrow({
      where: { clientId_key: { clientId: appAId, key: 'customer-team' } },
    });
    expect(kept.status).toBe('disabled');

    const disabledDefault = await api()
      .patch('/api/v1/clients/app-a/login-contexts/customer-team')
      .set('Authorization', await globalAuth())
      .send({ isDefault: true });
    expect(disabledDefault.status).toBe(409);

    const removed = await api()
      .delete('/api/v1/clients/app-a/login-contexts/customer-team')
      .set('Authorization', await globalAuth());
    expect(removed.status).toBe(204);
    const gone = await api()
      .get('/api/v1/clients/app-a/login-contexts/customer-team')
      .set('Authorization', await globalAuth());
    expect(gone.status).toBe(404);

    // The default context can never be deleted or disabled; another context must take over.
    const deleteDefault = await api()
      .delete('/api/v1/clients/app-a/login-contexts/customer-admin')
      .set('Authorization', await globalAuth());
    expect(deleteDefault.status).toBe(409);
    const disableDefault = await api()
      .post('/api/v1/clients/app-a/login-contexts/customer-admin/disable')
      .set('Authorization', await globalAuth());
    expect(disableDefault.status).toBe(409);
  });

  it('accepts only roles owned by the same client and valid policy values', async () => {
    const cases: Array<{ body: Record<string, unknown>; detail: string }> = [
      { body: contextBody('bad-global', { allowedRoles: ['idp:support'] }), detail: 'global role' },
      {
        body: contextBody('bad-foreign', { allowedRoles: ['app-b:member'], defaultRoles: [] }),
        detail: 'does not belong to client',
      },
      {
        body: contextBody('bad-subset', {
          allowedRoles: ['app-a:member'],
          defaultRoles: ['app-a:customer-admin'],
        }),
        detail: 'is not in allowedRoles',
      },
      { body: contextBody('bad-method', { loginMethods: ['sms'] }), detail: 'unsupported method' },
      { body: contextBody('bad-mfa', { mfaPolicy: 'sometimes' }), detail: 'mfaPolicy' },
      {
        body: contextBody('bad-registration', { registrationPolicy: 'open' }),
        detail: 'registrationPolicy',
      },
      {
        body: contextBody('bad-ttl', { sessionIdleTtl: 3600, sessionAbsoluteTtl: 1800 }),
        detail: 'sessionAbsoluteTtl',
      },
      { body: contextBody('Bad Key'), detail: 'key:' },
      { body: contextBody('bad-order', { sortOrder: -5 }), detail: 'sortOrder' },
    ];

    for (const { body, detail } of cases) {
      const response = await api()
        .post('/api/v1/clients/app-a/login-contexts')
        .set('Authorization', await globalAuth())
        .send(body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(response.body.detail.toString()).toContain(detail);
    }

    // A valid definition still works, so the failures are not from the fixture.
    const ok = await api()
      .post('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await globalAuth())
      .send(contextBody('valid'));
    expect(ok.status).toBe(201);
  });

  it('requires a fresh authentication for policy changes', async () => {
    const created = await api()
      .post('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await globalAuth())
      .send(contextBody('ops'));
    expect(created.status).toBe(201);

    const stalePolicy = await api()
      .patch('/api/v1/clients/app-a/login-contexts/ops')
      .set('Authorization', await globalAuth({ auth_time: staleAuthTime() }))
      .send({ mfaPolicy: 'required_all' });
    expect(stalePolicy.status).toBe(403);
    expect(stalePolicy.body.detail).toContain('recent authentication');

    const staleCreate = await api()
      .post('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await delegatedAuth({ auth_time: staleAuthTime() }))
      .send(contextBody('stale-create'));
    expect(staleCreate.status).toBe(403);

    // A non-policy change does not need a fresh login.
    const staleRename = await api()
      .patch('/api/v1/clients/app-a/login-contexts/ops')
      .set('Authorization', await globalAuth({ auth_time: staleAuthTime() }))
      .send({ name: 'Operations' });
    expect(staleRename.status).toBe(200);
    expect(staleRename.body.name).toBe('Operations');

    // Policy changes with a fresh login are allowed.
    const freshPolicy = await api()
      .patch('/api/v1/clients/app-a/login-contexts/ops')
      .set('Authorization', await globalAuth())
      .send({ mfaPolicy: 'required_all', loginMethods: ['password', 'otp'] });
    expect(freshPolicy.status).toBe(200);
    expect(freshPolicy.body.mfaPolicy).toBe('required_all');
  });

  it('keeps exactly one default context under concurrent switches', async () => {
    for (const key of ['base', 'beta', 'gamma']) {
      const created = await api()
        .post('/api/v1/clients/app-a/login-contexts')
        .set('Authorization', await globalAuth())
        .send(contextBody(key));
      expect(created.status).toBe(201);
    }

    const [beta, gamma] = await Promise.all([
      api()
        .patch('/api/v1/clients/app-a/login-contexts/beta')
        .set('Authorization', await globalAuth())
        .send({ isDefault: true }),
      api()
        .patch('/api/v1/clients/app-a/login-contexts/gamma')
        .set('Authorization', await globalAuth())
        .send({ isDefault: true }),
    ]);
    expect(beta.status).toBe(200);
    expect(gamma.status).toBe(200);

    const defaults = await prisma.clientLoginContext.findMany({
      where: { clientId: appAId, isDefault: true },
      select: { key: true },
    });
    expect(defaults).toHaveLength(1);
    const defaultKey = defaults[0]?.key;
    expect(['beta', 'gamma']).toContain(defaultKey);

    const clientRow = await prisma.client.findUniqueOrThrow({
      where: { id: appAId },
      select: { defaultLoginContextKey: true },
    });
    expect(clientRow.defaultLoginContextKey).toBe(defaultKey);

    // Clearing the default in place is refused: another context must take over.
    const clear = await api()
      .patch(`/api/v1/clients/app-a/login-contexts/${defaultKey}`)
      .set('Authorization', await globalAuth())
      .send({ isDefault: false });
    expect(clear.status).toBe(409);
  });

  it('refuses to delete a context that still has memberships', async () => {
    await api()
      .post('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await globalAuth())
      .send(contextBody('base'));
    const inUse = await api()
      .post('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await globalAuth())
      .send(contextBody('in-use'));
    expect(inUse.status).toBe(201);

    const member = await prisma.user.create({
      data: {
        tenantId: (await prisma.tenant.findFirstOrThrow()).id,
        username: 'member',
        email: 'member@example.com',
        displayName: 'Member',
        status: 'active',
      },
    });
    await prisma.clientMembership.create({
      data: {
        clientId: appAId,
        loginContextId: inUse.body.id,
        userId: member.id,
        status: 'active',
      },
    });

    const blocked = await api()
      .delete('/api/v1/clients/app-a/login-contexts/in-use')
      .set('Authorization', await globalAuth());
    expect(blocked.status).toBe(409);
    expect(blocked.body.detail).toContain('memberships');

    // Suspend the membership: history is preserved, so the delete stays blocked.
    await prisma.clientMembership.updateMany({
      where: { loginContextId: inUse.body.id },
      data: { status: 'suspended' },
    });
    const stillBlocked = await api()
      .delete('/api/v1/clients/app-a/login-contexts/in-use')
      .set('Authorization', await globalAuth());
    expect(stillBlocked.status).toBe(409);

    // Disable keeps the row and the membership.
    const disabled = await api()
      .post('/api/v1/clients/app-a/login-contexts/in-use/disable')
      .set('Authorization', await globalAuth());
    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe('disabled');
    const counted = await prisma.clientMembership.count({
      where: { loginContextId: inUse.body.id },
    });
    expect(counted).toBe(1);
  });

  it('scopes delegated admins to their own client', async () => {
    const ownList = await api()
      .get('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await delegatedAuth());
    expect(ownList.status).toBe(200);

    const crossList = await api()
      .get('/api/v1/clients/app-b/login-contexts')
      .set('Authorization', await delegatedAuth());
    expect(crossList.status).toBe(403);

    const crossCreate = await api()
      .post('/api/v1/clients/app-b/login-contexts')
      .set('Authorization', await delegatedAuth())
      .send(contextBody('intruder'));
    expect(crossCreate.status).toBe(403);

    const ownCreate = await api()
      .post('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await delegatedAuth())
      .send(contextBody('delegated'));
    expect(ownCreate.status).toBe(201);

    const crossPatch = await api()
      .patch('/api/v1/clients/app-b/login-contexts/anything')
      .set('Authorization', await delegatedAuth())
      .send({ name: 'nope' });
    expect(crossPatch.status).toBe(403);

    // A Global Admin may manage any client.
    const globalCrossList = await api()
      .get('/api/v1/clients/app-b/login-contexts')
      .set('Authorization', await globalAuth());
    expect(globalCrossList.status).toBe(200);
    expect(globalCrossList.body.items).toEqual([]);
  });

  it('audits every mutation with the context key only', async () => {
    await api()
      .post('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await globalAuth())
      .send(contextBody('base'));
    const created = await api()
      .post('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await globalAuth())
      .send(contextBody('audit-check'));
    expect(created.status).toBe(201);

    const updated = await api()
      .patch('/api/v1/clients/app-a/login-contexts/audit-check')
      .set('Authorization', await globalAuth())
      .send({ allowedRoles: ['app-a:customer-admin'], defaultRoles: ['app-a:customer-admin'] });
    expect(updated.status).toBe(200);

    const disabled = await api()
      .post('/api/v1/clients/app-a/login-contexts/audit-check/disable')
      .set('Authorization', await globalAuth());
    expect(disabled.status).toBe(200);

    const deleted = await api()
      .delete('/api/v1/clients/app-a/login-contexts/audit-check')
      .set('Authorization', await globalAuth());
    expect(deleted.status).toBe(204);

    const events = await prisma.auditEvent.findMany({
      where: {
        action: { startsWith: 'client.context.' },
        metadata: { path: ['key'], equals: 'audit-check' },
      },
      select: { action: true, metadata: true, clientId: true, targetType: true },
    });
    expect(events.map((event) => event.action).sort()).toEqual([
      'client.context.created',
      'client.context.deleted',
      'client.context.disabled',
      'client.context.updated',
    ]);
    for (const event of events) {
      expect(event.metadata).toEqual({ key: 'audit-check' });
      expect(event.clientId).toBe(appAId);
      expect(event.targetType).toBe('login_context');
    }
    // Role sets and policies are never copied into the append-only log.
    expect(JSON.stringify(events.map((event) => event.metadata))).not.toContain('app-a:');
  });

  it('publishes active contexts and a consistent default in the public config', async () => {
    await api()
      .post('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await globalAuth())
      .send(contextBody('customer-admin', { loginMethods: ['password', 'google'] }));
    await api()
      .post('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await globalAuth())
      .send(contextBody('customer-team'));
    const disabled = await api()
      .post('/api/v1/clients/app-a/login-contexts/customer-team/disable')
      .set('Authorization', await globalAuth());
    expect(disabled.status).toBe(200);

    const first = await api().get('/api/v1/clients/app-a/public-config');
    expect(first.status).toBe(200);
    expect(first.body.loginContexts).toEqual([
      {
        key: 'customer-admin',
        name: 'customer-admin',
        description: 'customer-admin context',
        methods: ['password', 'google'],
        mfaPolicy: 'optional',
      },
    ]);
    expect(first.body.defaultLoginContext).toBe('customer-admin');
    expect(JSON.stringify(first.body)).not.toContain('allowedRoles');

    // Switching the default is reflected without restarting anything.
    const team = await api()
      .post('/api/v1/clients/app-a/login-contexts')
      .set('Authorization', await globalAuth())
      .send(contextBody('support'));
    expect(team.status).toBe(201);
    const switched = await api()
      .patch('/api/v1/clients/app-a/login-contexts/support')
      .set('Authorization', await globalAuth())
      .send({ isDefault: true });
    expect(switched.status).toBe(200);

    const second = await api().get('/api/v1/clients/app-a/public-config');
    expect(second.status).toBe(200);
    expect(second.body.defaultLoginContext).toBe('support');
    expect(second.body.loginContexts.map((context: { key: string }) => context.key)).toEqual([
      'customer-admin',
      'support',
    ]);

    const clientRow = await prisma.client.findUniqueOrThrow({
      where: { id: appAId },
      select: { defaultLoginContextKey: true },
    });
    expect(clientRow.defaultLoginContextKey).toBe('support');
    expect(second.body.defaultLoginContext).toBe(clientRow.defaultLoginContextKey);
  });

  it('returns 404 for unknown clients and contexts', async () => {
    const unknownClient = await api()
      .get('/api/v1/clients/does-not-exist/login-contexts')
      .set('Authorization', await globalAuth());
    expect(unknownClient.status).toBe(404);

    const unknownContext = await api()
      .get('/api/v1/clients/app-a/login-contexts/missing')
      .set('Authorization', await globalAuth());
    expect(unknownContext.status).toBe(404);
  });
});
