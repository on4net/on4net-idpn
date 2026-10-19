import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaAuditEventRepository } from '../src/admin/audit/prisma-audit-repository.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { buildServer } from '../src/server.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3100';
const adminClientId = 'admin-panel';
const appClientId = 'app-a';
const EXPORT_CAP = 3;

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let prisma: PrismaClient;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let adminUserId: string;
let readerUserId: string;
let exporterUserId: string;
let unprivilegedUserId: string;
let appClientUuid: string;

const token = async (userId: string, options: { clientId?: string; scope?: string } = {}) =>
  keys.signAccessToken(
    {
      scope: options.scope ?? 'openid idp.admin',
      client_id: options.clientId ?? adminClientId,
    },
    {
      issuer,
      audience: adminClientId,
      subject: userId,
      expiresInSeconds: 300,
    },
  );

const auth = async (userId: string) => `Bearer ${await token(userId)}`;

let connectionStringValue = '';
const connectionString = (): string => connectionStringValue;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_audit_${Date.now()}`;
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
    audit: {
      adminClientId,
      permissions: createPrismaPermissionReader(prisma),
      events: createPrismaAuditEventRepository(prisma),
      audit: createPrismaAdminAudit(prisma),
      maxExportRows: EXPORT_CAP,
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });

  await prisma.client.create({
    data: {
      clientId: adminClientId,
      name: 'IDPN Admin Panel',
      type: 'web',
      redirectUris: [],
      postLogoutRedirectUris: [],
      allowedOrigins: [],
      scopes: ['openid', 'profile', 'idp.admin'],
      tenantId: tenant.id,
    },
  });
  const appClient = await prisma.client.create({
    data: {
      clientId: appClientId,
      name: 'App A',
      type: 'web',
      redirectUris: [],
      postLogoutRedirectUris: [],
      allowedOrigins: [],
      scopes: ['openid'],
      tenantId: tenant.id,
    },
  });
  appClientUuid = appClient.id;

  const readPermission = await prisma.permission.create({
    data: { key: 'idp:audit:read', description: 'Read audit events' },
  });
  const exportPermission = await prisma.permission.create({
    data: { key: 'idp:audit:export', description: 'Export audit events' },
  });
  const unrelatedPermission = await prisma.permission.create({
    data: { key: 'idp:user:read', description: 'View users' },
  });

  const readerRole = await prisma.role.create({
    data: {
      key: 'idp:audit-reader',
      name: 'Audit Reader',
      description: 'Read audit events',
      rolePermissions: { create: [{ permissionId: readPermission.id }] },
    },
  });
  const exporterRole = await prisma.role.create({
    data: {
      key: 'idp:audit-exporter',
      name: 'Audit Exporter',
      description: 'Read and export audit events',
      rolePermissions: {
        create: [{ permissionId: readPermission.id }, { permissionId: exportPermission.id }],
      },
    },
  });
  const unrelatedRole = await prisma.role.create({
    data: {
      key: 'idp:support',
      name: 'Support',
      description: 'No audit access',
      rolePermissions: { create: [{ permissionId: unrelatedPermission.id }] },
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
  const exporter = await makeUser('exporter');
  const unprivileged = await makeUser('support');
  adminUserId = admin.id;
  readerUserId = reader.id;
  exporterUserId = exporter.id;
  unprivilegedUserId = unprivileged.id;

  await prisma.assignment.createMany({
    data: [
      {
        subjectType: 'user',
        subjectId: admin.id,
        roleId: exporterRole.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
      {
        subjectType: 'user',
        subjectId: reader.id,
        roleId: readerRole.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
      {
        subjectType: 'user',
        subjectId: exporter.id,
        roleId: exporterRole.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
      {
        subjectType: 'user',
        subjectId: unprivileged.id,
        roleId: unrelatedRole.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
    ],
  });

  await prisma.auditEvent.createMany({
    data: [
      {
        occurredAt: new Date('2026-10-01T10:00:00Z'),
        actorType: 'user',
        actorId: reader.id,
        action: 'user.login.succeeded',
        targetType: 'user',
        targetId: reader.id,
        clientId: appClientUuid,
        result: 'success',
        metadata: { sid: 'session-1' },
      },
      {
        occurredAt: new Date('2026-10-02T10:00:00Z'),
        actorType: 'user',
        actorId: null,
        action: 'user.login.failed',
        targetType: 'user',
        targetId: reader.id,
        clientId: appClientUuid,
        result: 'failure',
        metadata: {
          reason: 'invalid_password',
          password: 'hunter2',
          nested: { token: 'leaked-token', safe: 'ok' },
        },
      },
      {
        occurredAt: new Date('2026-10-03T10:00:00Z'),
        actorType: 'admin',
        actorId: admin.id,
        action: 'client.secret.create',
        targetType: 'client',
        targetId: appClientUuid,
        clientId: appClientUuid,
        result: 'success',
        metadata: { secret: 'super-secret', keyId: 'key-1' },
      },
      {
        occurredAt: new Date('2026-09-30T10:00:00Z'),
        actorType: 'admin',
        actorId: admin.id,
        action: 'user.disable',
        targetType: 'user',
        targetId: reader.id,
        result: 'success',
        metadata: {},
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

describe('audit read authorization', () => {
  it('returns 401 without a token and 401 for a delegated app token', async () => {
    await request(app.server).get('/api/v1/audit-events').expect(401);

    const delegated = await keys.signAccessToken(
      { scope: 'openid idp.client-admin', client_id: appClientId },
      { issuer, audience: appClientId, subject: adminUserId, expiresInSeconds: 300 },
    );
    await request(app.server)
      .get('/api/v1/audit-events')
      .set('Authorization', `Bearer ${delegated}`)
      .expect(401);
  });

  it('returns 403 for a token from another client', async () => {
    const foreign = await token(adminUserId, { clientId: appClientId });
    await request(app.server)
      .get('/api/v1/audit-events')
      .set('Authorization', `Bearer ${foreign}`)
      .expect(403);
  });

  it('returns 403 when the caller has no audit permission', async () => {
    const response = await request(app.server)
      .get('/api/v1/audit-events')
      .set('Authorization', await auth(unprivilegedUserId))
      .expect(403);
    expect(response.body).toMatchObject({ type: expect.stringContaining('/forbidden') });
  });
});

describe('audit listing and filtering', () => {
  it('lists newest first with pagination and the public client id', async () => {
    const response = await request(app.server)
      .get('/api/v1/audit-events?page=2&limit=2')
      .set('Authorization', await auth(readerUserId))
      .expect(200);

    expect(response.body).toMatchObject({ page: 2, limit: 2, total: 4 });
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items.map((item: { action: string }) => item.action)).toEqual([
      'user.login.succeeded',
      'user.disable',
    ]);
    expect(response.body.items[0]).toMatchObject({
      clientId: appClientId,
      occurredAt: '2026-10-01T10:00:00.000Z',
    });
  });

  it('filters by action, actor, target type, result, public client and time range', async () => {
    const byAction = await request(app.server)
      .get('/api/v1/audit-events?action=user.login.failed')
      .set('Authorization', await auth(readerUserId))
      .expect(200);
    expect(byAction.body.total).toBe(1);

    const byActor = await request(app.server)
      .get(`/api/v1/audit-events?actorId=${adminUserId}`)
      .set('Authorization', await auth(readerUserId))
      .expect(200);
    expect(byActor.body.total).toBe(2);

    const byTarget = await request(app.server)
      .get('/api/v1/audit-events?targetType=user')
      .set('Authorization', await auth(readerUserId))
      .expect(200);
    expect(byTarget.body.total).toBe(3);

    const byResult = await request(app.server)
      .get('/api/v1/audit-events?result=failure')
      .set('Authorization', await auth(readerUserId))
      .expect(200);
    expect(byResult.body.total).toBe(1);

    const byClient = await request(app.server)
      .get(`/api/v1/audit-events?clientId=${appClientId}`)
      .set('Authorization', await auth(readerUserId))
      .expect(200);
    expect(byClient.body.total).toBe(3);

    const byRange = await request(app.server)
      .get('/api/v1/audit-events?from=2026-10-02T00%3A00%3A00Z&to=2026-10-02T23%3A59%3A59Z')
      .set('Authorization', await auth(readerUserId))
      .expect(200);
    expect(byRange.body.total).toBe(1);
    expect(byRange.body.items[0].action).toBe('user.login.failed');
  });

  it('returns an empty page for an unknown public client id', async () => {
    const response = await request(app.server)
      .get('/api/v1/audit-events?clientId=missing-app')
      .set('Authorization', await auth(readerUserId))
      .expect(200);
    expect(response.body).toMatchObject({ items: [], total: 0 });
  });

  it('redacts credentials from metadata on read', async () => {
    const response = await request(app.server)
      .get('/api/v1/audit-events?action=user.login.failed')
      .set('Authorization', await auth(readerUserId))
      .expect(200);
    const metadata = response.body.items[0].metadata as Record<string, unknown>;
    expect(metadata).toEqual({ reason: 'invalid_password', nested: { safe: 'ok' } });
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
    expect(JSON.stringify(response.body)).not.toContain('leaked-token');

    const secret = await request(app.server)
      .get('/api/v1/audit-events?action=client.secret.create')
      .set('Authorization', await auth(readerUserId))
      .expect(200);
    expect(secret.body.items[0].metadata).toEqual({ keyId: 'key-1' });
  });

  it('rejects invalid filters with 422', async () => {
    await request(app.server)
      .get('/api/v1/audit-events?actorId=not-a-uuid')
      .set('Authorization', await auth(readerUserId))
      .expect(422);
    await request(app.server)
      .get('/api/v1/audit-events?from=2026-10-03T00%3A00%3A00Z&to=2026-10-01T00%3A00%3A00Z')
      .set('Authorization', await auth(readerUserId))
      .expect(422);
  });
});

describe('audit export', () => {
  it('returns 403 when the caller only has idp:audit:read', async () => {
    const response = await request(app.server)
      .get('/api/v1/audit-events/export')
      .set('Authorization', await auth(readerUserId))
      .expect(403);
    expect(response.body).toMatchObject({ type: expect.stringContaining('/forbidden') });
  });

  it('exports CSV with attachment headers and an audit trail', async () => {
    const response = await request(app.server)
      .get('/api/v1/audit-events/export?format=csv&targetType=user')
      .set('Authorization', await auth(exporterUserId))
      .expect(200);

    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="audit-events-[0-9TZ-]+\.csv"$/,
    );
    const lines = response.text.trim().split('\n');
    expect(lines[0]).toBe(
      'id,occurredAt,actorType,actorId,action,targetType,targetId,clientId,ip,userAgent,result,metadata',
    );
    expect(lines).toHaveLength(1 + EXPORT_CAP);

    const record = await prisma.auditEvent.findFirst({
      where: { action: 'audit.export' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(record?.metadata).toMatchObject({ format: 'csv', rows: EXPORT_CAP, targetType: 'user' });
  });

  it('exports NDJSON with one event per line', async () => {
    const response = await request(app.server)
      .get('/api/v1/audit-events/export?format=ndjson')
      .set('Authorization', await auth(exporterUserId))
      .expect(200);

    expect(response.headers['content-type']).toContain('application/x-ndjson');
    const lines = response.text.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(EXPORT_CAP);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(response.text).not.toContain('hunter2');
  });
});
