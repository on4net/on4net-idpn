import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authenticateWithPassword } from '../src/auth/authenticate.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaAdminUserRepository } from '../src/admin/prisma-user-repository.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { buildServer } from '../src/server.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3100';
const adminClientId = 'admin-panel';
const userPassword = 'correct-horse-battery';

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let prisma: PrismaClient;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let tenantId: string;
let adminClientUuid: string;
let adminUserId: string;
let viewerUserId: string;

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

const auth = async (userId = adminUserId) => `Bearer ${await token(userId)}`;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

let connectionStringValue = '';
const connectionString = (): string => connectionStringValue;

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_admin_${Date.now()}`;
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

  const users = createPrismaAdminUserRepository(prisma);
  app = buildServer({
    issuer,
    keys,
    admin: {
      adminClientId,
      users,
      permissions: createPrismaPermissionReader(prisma),
      audit: createPrismaAdminAudit(prisma),
      now: () => new Date('2026-10-19T08:00:00Z'),
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  tenantId = tenant.id;

  const adminClient = await prisma.client.create({
    data: {
      clientId: adminClientId,
      name: 'IDPN Admin Panel',
      type: 'web',
      redirectUris: ['http://127.0.0.1:3001/auth/callback'],
      postLogoutRedirectUris: ['http://127.0.0.1:3001/'],
      allowedOrigins: ['http://127.0.0.1:3001'],
      scopes: ['openid', 'profile', 'idp.admin'],
      tenantId: tenant.id,
    },
  });
  adminClientUuid = adminClient.id;

  const permissionKeys = [
    'idp:user:read',
    'idp:user:write',
    'idp:session:read',
    'idp:session:write',
  ];
  const permissions = await Promise.all(
    permissionKeys.map((key) => prisma.permission.create({ data: { key, description: key } })),
  );
  const readOnly = permissions.filter((permission) => permission.key === 'idp:user:read');

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
      key: 'idp:reader',
      name: 'Reader',
      description: 'read only',
      rolePermissions: { create: readOnly.map((permission) => ({ permissionId: permission.id })) },
    },
  });

  const makeUser = async (username: string) => {
    const user = await prisma.user.create({
      data: {
        tenantId,
        username,
        email: `${username}@example.com`,
        displayName: username,
        status: 'active',
        passwordHash: await hashPassword(userPassword),
      },
    });
    return user;
  };

  const admin = await makeUser('admin');
  const viewer = await makeUser('viewer');
  adminUserId = admin.id;
  viewerUserId = viewer.id;

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
        subjectId: viewer.id,
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

describe('Admin API authentication and authorization', () => {
  it('returns 401 without a token and 401 for an invalid token', async () => {
    await request(app.server).get('/api/v1/users').expect(401);
    await request(app.server)
      .get('/api/v1/users')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
  });

  it('returns 403 for a token from another client', async () => {
    const foreign = `Bearer ${await token(adminUserId, { clientId: 'app-a' })}`;
    const response = await request(app.server)
      .get('/api/v1/users')
      .set('Authorization', foreign)
      .expect(403);
    expect(response.body).toMatchObject({ type: expect.stringContaining('/forbidden') });
  });

  it('returns 403 when the token lacks the idp.admin scope', async () => {
    const scoped = `Bearer ${await token(adminUserId, { scope: 'openid profile' })}`;
    await request(app.server).get('/api/v1/users').set('Authorization', scoped).expect(403);
  });

  it('returns 403 when the caller lacks the route permission', async () => {
    const response = await request(app.server)
      .post('/api/v1/users')
      .set('Authorization', await auth(viewerUserId))
      .send({ username: 'blocked', email: 'blocked@example.com', displayName: 'Blocked' })
      .expect(403);
    expect(response.body).toMatchObject({ type: expect.stringContaining('/forbidden') });
    expect(await prisma.user.count({ where: { username: 'blocked' } })).toBe(0);
  });

  it('reports the caller identity and permissions from the database', async () => {
    const response = await request(app.server)
      .get('/api/v1/me')
      .set('Authorization', await auth(viewerUserId))
      .expect(200);
    expect(response.body).toMatchObject({ id: viewerUserId, clientId: adminClientId });
    expect(response.body.permissions).toEqual(['idp:user:read']);
    // Identity and permissions must never be cached by a browser or an intermediary.
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('Admin API user lifecycle', () => {
  it('creates a user with a one-time temporary password and audits it', async () => {
    const response = await request(app.server)
      .post('/api/v1/users')
      .set('Authorization', await auth())
      .send({
        username: 'ali',
        email: 'ali@example.com',
        displayName: 'Ali Rezaei',
        locale: 'fa-IR',
      })
      .expect(201);

    expect(response.body.user).toMatchObject({
      username: 'ali',
      email: 'ali@example.com',
      status: 'active',
      mustChangePassword: true,
    });
    expect(typeof response.body.temporaryPassword).toBe('string');
    expect(JSON.stringify(response.body.user)).not.toContain(
      response.body.temporaryPassword as string,
    );

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'user.create', targetId: response.body.user.id },
    });
    expect(audit).toMatchObject({
      actorType: 'admin',
      actorId: adminUserId,
      result: 'success',
      clientId: adminClientUuid,
    });
    expect(JSON.stringify(audit?.metadata)).not.toContain(
      response.body.temporaryPassword as string,
    );
  });

  it('rejects a duplicate email with 409', async () => {
    await request(app.server)
      .post('/api/v1/users')
      .set('Authorization', await auth())
      .send({ username: 'ali2', email: 'ali@example.com', displayName: 'Ali 2' })
      .expect(409);
  });

  it('rejects invalid payloads and weak passwords with 422', async () => {
    await request(app.server)
      .post('/api/v1/users')
      .set('Authorization', await auth())
      .send({ username: 'x', email: 'not-an-email', displayName: '' })
      .expect(422);

    const weak = await request(app.server)
      .post('/api/v1/users')
      .set('Authorization', await auth())
      .send({
        username: 'weak',
        email: 'weak@example.com',
        displayName: 'Weak',
        password: 'short',
      })
      .expect(422);
    expect(JSON.stringify(weak.body)).toContain('12');
  });

  it('lists, searches and paginates users', async () => {
    const all = await request(app.server)
      .get('/api/v1/users?limit=2&page=1&sort=email:asc')
      .set('Authorization', await auth())
      .expect(200);
    expect(all.body).toMatchObject({ page: 1, limit: 2 });
    expect(all.body.items).toHaveLength(2);
    expect(all.body.total).toBeGreaterThanOrEqual(3);

    const search = await request(app.server)
      .get('/api/v1/users?q=ali&status=active')
      .set('Authorization', await auth())
      .expect(200);
    expect(search.body.items.map((item: { username: string }) => item.username)).toContain('ali');

    await request(app.server)
      .get('/api/v1/users?limit=1000')
      .set('Authorization', await auth())
      .expect(422);
  });

  it('reads and updates a user, auditing the change', async () => {
    const list = await request(app.server)
      .get('/api/v1/users?q=ali')
      .set('Authorization', await auth())
      .expect(200);
    const userId = list.body.items[0].id as string;

    const updated = await request(app.server)
      .patch(`/api/v1/users/${userId}`)
      .set('Authorization', await auth())
      .send({ displayName: 'Ali R.', locale: 'en-US' })
      .expect(200);
    expect(updated.body).toMatchObject({ displayName: 'Ali R.', locale: 'en-US' });

    await request(app.server)
      .patch(`/api/v1/users/${userId}`)
      .set('Authorization', await auth())
      .send({})
      .expect(422);

    await request(app.server)
      .get('/api/v1/users/00000000-0000-0000-0000-000000000000')
      .set('Authorization', await auth())
      .expect(404);

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'user.update', targetId: userId },
    });
    expect(audit?.metadata).toMatchObject({ fields: ['displayName', 'locale'] });
  });

  it('clears email verification when an admin changes the address', async () => {
    const list = await request(app.server)
      .get('/api/v1/users?q=viewer')
      .set('Authorization', await auth())
      .expect(200);
    const userId = list.body.items[0].id as string;
    await prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') },
    });

    await request(app.server)
      .patch(`/api/v1/users/${userId}`)
      .set('Authorization', await auth())
      .send({ email: `moved-${Date.now()}@example.com` })
      .expect(200);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // The new address has never been proven; keeping the old verification would let an
    // admin-controlled email change inherit a verified mailbox.
    expect(stored.emailVerifiedAt).toBeNull();

    // A change that does not touch the address keeps the verification.
    await prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') },
    });
    await request(app.server)
      .patch(`/api/v1/users/${userId}`)
      .set('Authorization', await auth())
      .send({ displayName: 'Viewer' })
      .expect(200);
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(unchanged.emailVerifiedAt).not.toBeNull();
  });

  it('refuses an admin token once the administrator account is disabled', async () => {
    const token = await auth();
    await prisma.user.update({ where: { id: viewerUserId }, data: { status: 'disabled' } });
    try {
      const response = await request(app.server)
        .get('/api/v1/users')
        .set('Authorization', await auth(viewerUserId));
      expect(response.status).toBe(403);
    } finally {
      await prisma.user.update({ where: { id: viewerUserId }, data: { status: 'active' } });
    }
    await request(app.server).get('/api/v1/users').set('Authorization', token).expect(200);
  });
});

describe('Admin API status actions', () => {
  const createActiveUser = async (username: string) => {
    const user = await prisma.user.create({
      data: {
        tenantId,
        username,
        email: `${username}@example.com`,
        displayName: username,
        status: 'active',
        passwordHash: await hashPassword(userPassword),
      },
    });
    return user;
  };

  it('disables a user, revokes the sessions and blocks sign-in', async () => {
    const user = await createActiveUser('tosdisable');
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        createdAt: new Date('2026-10-19T07:00:00Z'),
        lastSeenAt: new Date('2026-10-19T07:00:00Z'),
        idleExpiresAt: new Date('2026-10-19T07:30:00Z'),
        absoluteExpiresAt: new Date('2026-10-19T15:00:00Z'),
        amr: ['pwd'],
        acr: 'urn:on4net:acr:pwd',
      },
    });

    const response = await request(app.server)
      .post(`/api/v1/users/${user.id}/disable`)
      .set('Authorization', await auth())
      .expect(200);
    expect(response.body.user.status).toBe('disabled');
    expect(response.body.revokedSessions).toBe(1);

    const stored = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(stored.revokedAt).not.toBeNull();
    expect(stored.revokeReason).toBe('admin_disabled');

    const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const attempt = await authenticateWithPassword(
      {
        id: reloaded.id,
        status: reloaded.status,
        passwordHash: reloaded.passwordHash,
        lockedUntil: reloaded.lockedUntil,
        deletedAt: reloaded.deletedAt,
      },
      userPassword,
    );
    expect(attempt).toMatchObject({ ok: false, reason: 'user_disabled' });

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'user.disable', targetId: user.id },
    });
    expect(audit?.metadata).toMatchObject({ status: 'disabled', revokedSessions: 1 });
  });

  it('enables a disabled user and unlocks a locked one', async () => {
    const user = await createActiveUser('tounlock');
    await prisma.user.update({
      where: { id: user.id },
      data: {
        status: 'locked',
        lockedUntil: new Date('2030-01-01T00:00:00Z'),
        failedLoginCount: 5,
      },
    });

    const unlocked = await request(app.server)
      .post(`/api/v1/users/${user.id}/unlock`)
      .set('Authorization', await auth())
      .expect(200);
    expect(unlocked.body.user).toMatchObject({
      status: 'active',
      lockedUntil: null,
    });

    await prisma.user.update({ where: { id: user.id }, data: { status: 'disabled' } });
    const enabled = await request(app.server)
      .post(`/api/v1/users/${user.id}/enable`)
      .set('Authorization', await auth())
      .expect(200);
    expect(enabled.body.user.status).toBe('active');
  });

  it('refuses to unlock a disabled account instead of silently re-enabling it', async () => {
    const user = await createActiveUser('disabledunlock');
    await prisma.user.update({ where: { id: user.id }, data: { status: 'disabled' } });

    const refused = await request(app.server)
      .post(`/api/v1/users/${user.id}/unlock`)
      .set('Authorization', await auth());
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toContain('disabled');

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.status).toBe('disabled');
  });

  it('resets a password, revokes sessions and requires a change on next sign-in', async () => {
    const user = await createActiveUser('toreset');
    await prisma.session.create({
      data: {
        userId: user.id,
        idleExpiresAt: new Date('2030-01-01T00:00:00Z'),
        absoluteExpiresAt: new Date('2030-01-02T00:00:00Z'),
        amr: ['pwd'],
        acr: 'urn:on4net:acr:pwd',
      },
    });

    const response = await request(app.server)
      .post(`/api/v1/users/${user.id}/reset-password`)
      .set('Authorization', await auth())
      .send({})
      .expect(200);

    expect(response.body.revokedSessions).toBe(1);
    expect(response.body.user.mustChangePassword).toBe(true);
    const temporary = response.body.temporaryPassword as string;
    const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(reloaded.passwordHash ?? '', temporary)).toBe(true);
    expect(await verifyPassword(reloaded.passwordHash ?? '', userPassword)).toBe(false);

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'user.reset_password', targetId: user.id },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.metadata)).not.toContain(temporary);
  });

  it('lists and revokes sessions', async () => {
    const user = await createActiveUser('withsessions');
    const first = await prisma.session.create({
      data: {
        userId: user.id,
        idleExpiresAt: new Date('2030-01-01T00:00:00Z'),
        absoluteExpiresAt: new Date('2030-01-02T00:00:00Z'),
        amr: ['pwd'],
        acr: 'urn:on4net:acr:pwd',
      },
    });
    await prisma.session.create({
      data: {
        userId: user.id,
        idleExpiresAt: new Date('2030-01-01T00:00:00Z'),
        absoluteExpiresAt: new Date('2030-01-02T00:00:00Z'),
        amr: ['pwd'],
        acr: 'urn:on4net:acr:pwd',
      },
    });

    const listed = await request(app.server)
      .get(`/api/v1/users/${user.id}/sessions`)
      .set('Authorization', await auth())
      .expect(200);
    expect(listed.body.items).toHaveLength(2);
    expect(JSON.stringify(listed.body)).not.toContain('token');

    await request(app.server)
      .delete(`/api/v1/users/${user.id}/sessions/${first.id}`)
      .set('Authorization', await auth())
      .expect(200);

    const revokedOne = await prisma.session.findUniqueOrThrow({ where: { id: first.id } });
    expect(revokedOne.revokedAt).not.toBeNull();

    const revokedAll = await request(app.server)
      .delete(`/api/v1/users/${user.id}/sessions`)
      .set('Authorization', await auth())
      .expect(200);
    expect(revokedAll.body.revoked).toBe(1);
  });

  it('ignores assignments outside the global scope', async () => {
    const scoped = await createActiveUser('scoped');
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'idp:superadmin' } });
    await prisma.assignment.create({
      data: {
        subjectType: 'user',
        subjectId: scoped.id,
        roleId: role.id,
        scopeType: 'organization',
        scopeId: randomUUID(),
        assignedBy: adminUserId,
      },
    });

    await request(app.server)
      .get('/api/v1/users')
      .set('Authorization', await auth(scoped.id))
      .expect(403);
  });
});
