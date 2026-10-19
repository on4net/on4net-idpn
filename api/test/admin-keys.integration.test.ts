import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodeProtectedHeader } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
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
let prisma: PrismaClient;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let adminUserId: string;
let readerUserId: string;
let unprivilegedUserId: string;

let connectionStringValue = '';
const connectionString = (): string => connectionStringValue;

const token = async (
  userId: string,
  options: { clientId?: string; scope?: string; audience?: string } = {},
) =>
  keys.signAccessToken(
    {
      scope: options.scope ?? 'openid idp.admin',
      client_id: options.clientId ?? adminClientId,
    },
    {
      issuer,
      audience: options.audience ?? adminClientId,
      subject: userId,
      expiresInSeconds: 300,
    },
  );

const auth = async (userId: string, options: { scope?: string } = {}) =>
  `Bearer ${await token(userId, options)}`;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_keys_${Date.now()}`;
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

  keys = new SigningKeyManager(new MemorySigningKeyRepository(), () => new Date(), {
    retiredRetentionSeconds: 3600,
    rotationDueAfterDays: 90,
  });
  await keys.ensureKey();

  app = buildServer({
    issuer,
    keys,
    adminKeys: {
      adminClientId,
      permissions: createPrismaPermissionReader(prisma),
      audit: createPrismaAdminAudit(prisma),
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

  const permissions = await Promise.all(
    ['idp:key:read', 'idp:key:write'].map((key) =>
      prisma.permission.create({ data: { key, description: key } }),
    ),
  );
  const readOnly = permissions.filter((permission) => permission.key === 'idp:key:read');

  const superRole = await prisma.role.create({
    data: {
      key: 'idp:superadmin',
      name: 'Super Admin',
      description: 'all',
      rolePermissions: {
        create: permissions.map((permission) => ({ permissionId: permission.id })),
      },
    },
  });
  const readerRole = await prisma.role.create({
    data: {
      key: 'idp:key-reader',
      name: 'Key Reader',
      description: 'read only',
      rolePermissions: { create: readOnly.map((permission) => ({ permissionId: permission.id })) },
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
  const unprivileged = await makeUser('unprivileged');
  adminUserId = admin.id;
  readerUserId = reader.id;
  unprivilegedUserId = unprivileged.id;

  await prisma.assignment.createMany({
    data: [
      {
        subjectType: 'user',
        subjectId: admin.id,
        roleId: superRole.id,
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

const auditRows = () =>
  prisma.auditEvent.findMany({
    where: { action: 'key.rotate' },
    orderBy: { occurredAt: 'asc' },
  });

describe('signing key Admin API authorization', () => {
  it('returns 401 without a bearer token and for an invalid token', async () => {
    await request(app.server).get('/api/v1/keys').expect(401);
    await request(app.server)
      .get('/api/v1/keys')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
    await request(app.server).post('/api/v1/keys/rotate').expect(401);
  });

  it('returns 403 without the idp.admin scope or the required permission', async () => {
    await request(app.server)
      .get('/api/v1/keys')
      .set('Authorization', await auth(adminUserId, { scope: 'openid' }))
      .expect(403);

    const unprivileged = await request(app.server)
      .get('/api/v1/keys')
      .set('Authorization', await auth(unprivilegedUserId))
      .expect(403);
    expect(unprivileged.body.title).toBe('Forbidden');
  });

  it('lets a read-only key administrator list keys but not rotate them', async () => {
    await request(app.server)
      .get('/api/v1/keys')
      .set('Authorization', await auth(readerUserId))
      .expect(200);

    await request(app.server)
      .post('/api/v1/keys/rotate')
      .set('Authorization', await auth(readerUserId))
      .send({})
      .expect(403);
  });
});

describe('signing key rotation', () => {
  it('lists keys and rotation health without private material', async () => {
    const response = await request(app.server)
      .get('/api/v1/keys')
      .set('Authorization', await auth(adminUserId))
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.rotationDue).toBe(false);
    expect(response.body.rotationDueAfterDays).toBe(90);
    expect(response.body.keys).toHaveLength(1);
    expect(response.body.keys[0]).toMatchObject({
      alg: 'ES256',
      status: 'active',
      publishedInJwks: true,
    });
    expect(Date.parse(response.body.keys[0].createdAt)).not.toBeNaN();
    expect(response.body.activeKey.kid).toBe(response.body.keys[0].kid);
    expect(response.body.keys[0].privateJwk).toBeUndefined();
    expect(response.body.keys[0].publicJwk).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toMatch(/"private|"public|"d":/);
  });

  it('rotates without downtime and keeps the previous key in JWKS for the overlap', async () => {
    const before = await request(app.server).get('/.well-known/jwks.json').expect(200);
    const oldKid = before.body.keys[0].kid as string;
    const oldToken = await token(adminUserId);

    // The old token is accepted before rotation ...
    await request(app.server)
      .get('/api/v1/keys')
      .set('Authorization', `Bearer ${oldToken}`)
      .expect(200);

    // ... and discovery/JWKS stay available while the rotation runs.
    const [rotate, ...during] = await Promise.all([
      request(app.server)
        .post('/api/v1/keys/rotate')
        .set('Authorization', `Bearer ${oldToken}`)
        .send({}),
      ...Array.from({ length: 6 }, (_, index) =>
        request(app.server)
          .get(index % 2 === 0 ? '/.well-known/jwks.json' : '/.well-known/openid-configuration')
          .expect(200),
      ),
    ]);

    expect(rotate.status).toBe(200);
    expect(rotate.body.previousKid).toBe(oldKid);
    expect(rotate.body.previousRevoked).toBe(false);
    expect(rotate.body.activeKey.kid).not.toBe(oldKid);
    for (const response of during) {
      expect(response.status).toBe(200);
    }

    const jwks = await request(app.server).get('/.well-known/jwks.json').expect(200);
    expect(jwks.body.keys.map((key: { kid: string }) => key.kid).sort()).toEqual(
      [oldKid, rotate.body.activeKey.kid].sort(),
    );
    await request(app.server).get('/.well-known/openid-configuration').expect(200);

    // The token issued before the rotation remains valid until it expires.
    await request(app.server)
      .get('/api/v1/keys')
      .set('Authorization', `Bearer ${oldToken}`)
      .expect(200);

    // A token issued now carries the new kid and is accepted too.
    const newToken = await token(adminUserId);
    expect(decodeProtectedHeader(newToken).kid).toBe(rotate.body.activeKey.kid);
    await request(app.server)
      .get('/api/v1/keys')
      .set('Authorization', `Bearer ${newToken}`)
      .expect(200);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'key.rotate', targetType: 'signing_key' });
    expect(rows[0]?.metadata).toMatchObject({
      kid: rotate.body.activeKey.kid,
      previousKid: oldKid,
      previousRevoked: false,
      trigger: 'manual',
    });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('"d"');
  });

  it('revokes the previous key during an emergency rotation', async () => {
    const listing = await request(app.server)
      .get('/api/v1/keys')
      .set('Authorization', await auth(adminUserId))
      .expect(200);
    const compromisedKid = listing.body.activeKey.kid as string;
    const compromisedToken = await token(adminUserId);

    const rotate = await request(app.server)
      .post('/api/v1/keys/rotate')
      .set('Authorization', await auth(adminUserId))
      .send({ revokePrevious: true })
      .expect(200);

    expect(rotate.body.previousKid).toBe(compromisedKid);
    expect(rotate.body.previousRevoked).toBe(true);

    // The revoked key is not published, so a token it signed fails. The earlier retired
    // key from the normal rotation stays published until its retention window ends.
    const jwks = await request(app.server).get('/.well-known/jwks.json').expect(200);
    const publishedKids = jwks.body.keys.map((key: { kid: string }) => key.kid);
    expect(publishedKids).not.toContain(compromisedKid);
    expect(publishedKids).toContain(rotate.body.activeKey.kid);
    expect(publishedKids).toHaveLength(2);
    await request(app.server)
      .get('/api/v1/keys')
      .set('Authorization', `Bearer ${compromisedToken}`)
      .expect(401);

    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.metadata).toMatchObject({
      kid: rotate.body.activeKey.kid,
      previousKid: compromisedKid,
      previousRevoked: true,
      trigger: 'emergency',
    });

    const after = await request(app.server)
      .get('/api/v1/keys')
      .set('Authorization', await auth(adminUserId))
      .expect(200);
    expect(
      after.body.keys.find((key: { kid: string }) => key.kid === compromisedKid),
    ).toMatchObject({ status: 'revoked', publishedInJwks: false });
    expect(after.body.keys).toHaveLength(3);
  });
});
