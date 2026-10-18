import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaPasswordStore, recordAuditEvent } from '../src/audit/prisma-audit.js';
import { hashPassword, type Argon2Params } from '../src/auth/password.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { changePassword } from '../src/users/change-password.js';

const FAST: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let prisma: PrismaClient;
let connectionString: string;

async function migrateDeploy(): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { promisify } = await import('node:util');
  await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url)),
      'migrate',
      'deploy',
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, DATABASE_URL: connectionString },
    },
  );
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_pwd_${Date.now()}`;
    serverClient = new Client({ connectionString: external });
    await serverClient.connect();
    await serverClient.query(`CREATE DATABASE "${scratchDatabase}"`);
    const url = new URL(external);
    url.pathname = `/${scratchDatabase}`;
    connectionString = url.toString();
  } else {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(180_000)
      .start();
    connectionString = container.getConnectionUri();
  }

  await migrateDeploy();
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

async function createClient() {
  return prisma.client.create({
    data: {
      clientId: `client-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name: 'Test client',
      type: 'web',
      redirectUris: [],
      postLogoutRedirectUris: [],
      allowedOrigins: [],
      scopes: ['openid'],
      allowedEmailDomains: [],
      tenantId: (await prisma.tenant.findFirstOrThrow()).id,
    },
  });
}

async function createUser(overrides: { status?: 'active' | 'disabled' } = {}) {
  const tenant = await prisma.tenant.create({
    data: { slug: `tenant-${Date.now()}-${Math.random()}`, name: 'Test tenant' },
  });
  const passwordHash = await hashPassword('existing-password-12', FAST);
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: `user${Date.now()}${Math.floor(Math.random() * 1000)}`,
      email: `user${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`,
      displayName: 'Test User',
      status: overrides.status ?? 'active',
      passwordHash,
    },
  });
  return user;
}

describe('changePassword against PostgreSQL', () => {
  it('persists the new hash, revokes sessions and tokens, and audits', async () => {
    const user = await createUser();
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        idleExpiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt: new Date(Date.now() + 120_000),
        acr: 'urn:on4net:acr:pwd',
        amr: ['pwd'],
      },
    });
    const client = await createClient();
    await prisma.refreshToken.create({
      data: {
        tokenHash: `hash-${Date.now()}`,
        familyId: '11111111-1111-1111-1111-111111111111',
        clientId: client.id,
        userId: user.id,
        sessionId: session.id,
        scope: ['openid'],
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const result = await changePassword(createPrismaPasswordStore(prisma), hashPassword, {
      userId: user.id,
      currentPassword: 'existing-password-12',
      newPassword: 'a-brand-new-password',
    });

    expect(result).toMatchObject({ ok: true, revokedSessions: 1, revokedRefreshTokens: 1 });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.passwordHash).not.toBeNull();
    expect(stored.passwordHash).not.toContain('a-brand-new-password');
    expect(stored.passwordChangedAt).not.toBeNull();

    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    expect(sessions[0]?.revokedAt).not.toBeNull();
    expect(sessions[0]?.revokeReason).toBe('password_change');

    const tokens = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(tokens[0]?.revokedAt).not.toBeNull();

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'user.password.changed', targetId: user.id },
    });
    expect(audit.result).toBe('success');
    expect(JSON.stringify(audit.metadata)).not.toContain('a-brand-new-password');
  }, 60_000);

  it('refuses a disabled user', async () => {
    const user = await createUser({ status: 'disabled' });

    const result = await changePassword(createPrismaPasswordStore(prisma), hashPassword, {
      userId: user.id,
      newPassword: 'a-brand-new-password',
    });

    expect(result).toEqual({ ok: false, reason: 'user_disabled' });
  }, 60_000);

  it('strips credentials before persisting audit metadata', async () => {
    await recordAuditEvent(prisma, {
      actorType: 'system',
      action: 'test.secret_scrub',
      result: 'success',
      metadata: { password: 'leak', nested: { tokenHash: 'leak', keep: 'ok' } },
    });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'test.secret_scrub' },
    });
    expect(event.metadata).toEqual({ nested: { keep: 'ok' } });
  }, 60_000);
});
