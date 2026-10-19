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
import { createPrismaSocialProviderRepository } from '../src/admin/social-providers/prisma-social-provider-repository.js';
import { createSecretBox, type SecretBox } from '../src/crypto/secret-box.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { buildServer } from '../src/server.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3200';
const adminClientId = 'admin-panel';
const secretKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const appASecret = 'GOCSPX-app-a-google-secret';
const appASecretRotated = 'GOCSPX-app-a-google-secret-rotated';
const appBSecret = 'GOCSPX-app-b-facebook-secret';

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let prisma: PrismaClient;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let box: SecretBox;
let adminUserId: string;
let appAAdminId: string;
let appAInternalId: string;
let appBInternalId: string;

const connectionString = (): string => connectionStringValue;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

interface TokenOptions {
  scope?: string;
  authTime?: number;
}

async function tokenFor(
  userId: string,
  clientId: string,
  options: TokenOptions = {},
): Promise<string> {
  const accessToken = await keys.signAccessToken(
    {
      scope: options.scope ?? 'openid idp.client-admin',
      client_id: clientId,
      auth_time: options.authTime ?? nowSeconds(),
    },
    { issuer, audience: clientId, subject: userId, expiresInSeconds: 300 },
  );
  return 'Bearer ' + accessToken;
}

const globalToken = (options: TokenOptions = {}): Promise<string> =>
  tokenFor(adminUserId, adminClientId, { scope: 'openid idp.admin', ...options });

const providerRow = async (clientId: string, provider: 'google' | 'facebook') => {
  const client = await prisma.client.findUniqueOrThrow({
    where: { clientId },
    select: { id: true },
  });
  return prisma.clientSocialProvider.findUnique({
    where: { clientId_provider: { clientId: client.id, provider } },
  });
};

const jsonOf = (body: unknown): string => JSON.stringify(body);

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_social_${Date.now()}`;
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
  box = createSecretBox(secretKey);

  app = buildServer({
    issuer,
    keys,
    socialProviders: {
      adminClientId,
      permissions: createPrismaPermissionReader(prisma),
      providers: createPrismaSocialProviderRepository(prisma),
      audit: createPrismaAdminAudit(prisma),
      secretBox: box,
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
  appAInternalId = appA.id;
  appBInternalId = appB.id;

  const permissionRows = new Map<string, string>();
  for (const key of ['idp:social-provider:read', 'idp:social-provider:write']) {
    const row = await prisma.permission.create({ data: { key, description: key } });
    permissionRows.set(key, row.id);
  }
  const permissionIds = [...permissionRows.values()];

  const globalAdminRole = await prisma.role.create({
    data: {
      key: 'idp:social-admin',
      name: 'Social admin',
      description: 'global social provider admin',
      rolePermissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
    },
  });
  const appAAdminRole = await prisma.role.create({
    data: {
      key: 'app-a:user-admin',
      name: 'App A user admin',
      description: 'delegated social admin',
      clientId: appA.id,
      rolePermissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
    },
  });
  const appBAdminRole = await prisma.role.create({
    data: {
      key: 'app-b:user-admin',
      name: 'App B user admin',
      description: 'delegated social admin',
      clientId: appB.id,
      rolePermissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
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
  const appAAdmin = await makeUser('delegated-a');
  const appBAdmin = await makeUser('delegated-b');
  adminUserId = admin.id;
  appAAdminId = appAAdmin.id;

  await prisma.assignment.createMany({
    data: [
      {
        subjectType: 'user',
        subjectId: admin.id,
        roleId: globalAdminRole.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
      {
        subjectType: 'user',
        subjectId: appAAdmin.id,
        roleId: appAAdminRole.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
      {
        subjectType: 'user',
        subjectId: appBAdmin.id,
        roleId: appBAdminRole.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
    ],
  });
}, 600_000);

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

describe('social provider credentials', () => {
  it('requires an authenticated admin', async () => {
    await request(app.server).get('/api/v1/clients/app-a/social-providers').expect(401);
  });

  it('creates a provider, returns the exact callback URL and never the secret', async () => {
    const response = await request(app.server)
      .put('/api/v1/clients/app-a/social-providers/google')
      .set('Authorization', await globalToken())
      .send({
        clientKey: 'app-a-google-key.apps.googleusercontent.com',
        clientSecret: appASecret,
        scopes: ['openid', 'email', 'profile'],
        allowedEmailDomains: ['Example.COM'],
        enabled: true,
      })
      .expect(200);

    expect(response.body).toEqual({
      provider: 'google',
      clientKey: 'app-a-google-key.apps.googleusercontent.com',
      scopes: ['openid', 'email', 'profile'],
      allowedEmailDomains: ['example.com'],
      enabled: true,
      callbackUrl: `${issuer}/oauth2/social/app-a/google/callback`,
      updatedAt: expect.any(String),
    });
    const payload = jsonOf(response.body);
    expect(payload).not.toContain(appASecret);
    expect(payload).not.toContain('clientSecret');

    const row = await providerRow('app-a', 'google');
    expect(row).not.toBeNull();
    if (row === null) {
      throw new Error('provider row was not created');
    }
    expect(Buffer.from(row.clientSecretEncrypted).toString('utf8')).not.toContain(appASecret);
    expect(box.decrypt(row.clientSecretEncrypted)).toBe(appASecret);
    expect(row.enabled).toBe(true);
  });

  it('lists only the public projection', async () => {
    const response = await request(app.server)
      .get('/api/v1/clients/app-a/social-providers')
      .set('Authorization', await globalToken())
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      provider: 'google',
      clientKey: 'app-a-google-key.apps.googleusercontent.com',
      scopes: ['openid', 'email', 'profile'],
      allowedEmailDomains: ['example.com'],
      enabled: true,
      callbackUrl: `${issuer}/oauth2/social/app-a/google/callback`,
    });
    expect(jsonOf(response.body)).not.toContain(appASecret);
    expect(jsonOf(response.body)).not.toContain('clientSecret');
  });

  it('updates without a secret and keeps the stored credential', async () => {
    const before = await providerRow('app-a', 'google');
    if (before === null) {
      throw new Error('provider row is missing');
    }

    const response = await request(app.server)
      .put('/api/v1/clients/app-a/social-providers/google')
      .set('Authorization', await globalToken())
      .send({ clientKey: 'app-a-google-key-v2', enabled: false })
      .expect(200);

    expect(response.body).toMatchObject({
      clientKey: 'app-a-google-key-v2',
      enabled: false,
      scopes: ['openid', 'email', 'profile'],
      allowedEmailDomains: ['example.com'],
    });

    const after = await providerRow('app-a', 'google');
    if (after === null) {
      throw new Error('provider row disappeared');
    }
    expect(Buffer.from(after.clientSecretEncrypted).equals(before.clientSecretEncrypted)).toBe(
      true,
    );
    expect(box.decrypt(after.clientSecretEncrypted)).toBe(appASecret);
  });

  it('rotates the secret when one is supplied', async () => {
    await request(app.server)
      .put('/api/v1/clients/app-a/social-providers/google')
      .set('Authorization', await globalToken())
      .send({ clientKey: 'app-a-google-key-v2', clientSecret: appASecretRotated, enabled: true })
      .expect(200);

    const row = await providerRow('app-a', 'google');
    if (row === null) {
      throw new Error('provider row disappeared');
    }
    expect(box.decrypt(row.clientSecretEncrypted)).toBe(appASecretRotated);
  });

  it('allows a delegated admin to manage its own app only', async () => {
    const list = await request(app.server)
      .get('/api/v1/clients/app-a/social-providers')
      .set('Authorization', await tokenFor(appAAdminId, 'app-a'))
      .expect(200);
    expect(list.body.items.map((item: { provider: string }) => item.provider)).toEqual(['google']);

    const updated = await request(app.server)
      .put('/api/v1/clients/app-a/social-providers/google')
      .set('Authorization', await tokenFor(appAAdminId, 'app-a'))
      .send({ clientKey: 'app-a-google-key-v3' })
      .expect(200);
    expect(updated.body.clientKey).toBe('app-a-google-key-v3');
  });

  it('rejects a delegated token for another app on read, write and delete', async () => {
    // Global admin sets up a Facebook credential for app-b first.
    const createdB = await request(app.server)
      .put('/api/v1/clients/app-b/social-providers/facebook')
      .set('Authorization', await globalToken())
      .send({ clientKey: 'app-b-facebook-key', clientSecret: appBSecret })
      .expect(200);
    expect(createdB.body.callbackUrl).toBe(`${issuer}/oauth2/social/app-b/facebook/callback`);

    await request(app.server)
      .get('/api/v1/clients/app-b/social-providers')
      .set('Authorization', await tokenFor(appAAdminId, 'app-a'))
      .expect(403);

    await request(app.server)
      .put('/api/v1/clients/app-b/social-providers/facebook')
      .set('Authorization', await tokenFor(appAAdminId, 'app-a'))
      .send({ clientKey: 'hijacked' })
      .expect(403);

    await request(app.server)
      .delete('/api/v1/clients/app-b/social-providers/facebook')
      .set('Authorization', await tokenFor(appAAdminId, 'app-a'))
      .expect(403);

    const row = await providerRow('app-b', 'facebook');
    expect(row).not.toBeNull();
    expect(row?.clientKey).toBe('app-b-facebook-key');
  });

  it('rejects stale tokens for step-up operations', async () => {
    const stale = await tokenFor(appAAdminId, 'app-a', { authTime: nowSeconds() - 3600 });

    const update = await request(app.server)
      .put('/api/v1/clients/app-a/social-providers/google')
      .set('Authorization', stale)
      .send({ clientKey: 'stale-write' })
      .expect(403);
    expect(update.body.detail).toMatch(/recent authentication/);

    await request(app.server)
      .delete('/api/v1/clients/app-a/social-providers/google')
      .set('Authorization', stale)
      .expect(403);

    const staleGlobal = await globalToken({ authTime: nowSeconds() - 3600 });
    const globalDelete = await request(app.server)
      .delete('/api/v1/clients/app-b/social-providers/facebook')
      .set('Authorization', staleGlobal)
      .expect(403);
    expect(globalDelete.body.detail).toMatch(/recent authentication/);

    const row = await providerRow('app-a', 'google');
    expect(row).not.toBeNull();
  });

  it('rejects an unknown provider with 422', async () => {
    const auth = { Authorization: await globalToken() };

    const update = await request(app.server)
      .put('/api/v1/clients/app-a/social-providers/github')
      .set(auth)
      .send({ clientKey: 'github-key', clientSecret: 'github-secret' })
      .expect(422);
    expect(update.body.detail).toContain('provider');

    await request(app.server)
      .delete('/api/v1/clients/app-a/social-providers/github')
      .set(auth)
      .expect(422);
  });

  it('requires a secret when creating a provider', async () => {
    const response = await request(app.server)
      .put('/api/v1/clients/app-a/social-providers/facebook')
      .set('Authorization', await globalToken())
      .send({ clientKey: 'app-a-facebook-key' })
      .expect(422);
    expect(response.body.detail).toContain('clientSecret');

    await expect(providerRow('app-a', 'facebook')).resolves.toBeNull();
  });

  it('returns 404 for an unknown client', async () => {
    await request(app.server)
      .get('/api/v1/clients/missing-app/social-providers')
      .set('Authorization', await globalToken())
      .expect(404);
  });

  it('deletes the credential without exposing the secret', async () => {
    const response = await request(app.server)
      .delete('/api/v1/clients/app-b/social-providers/facebook')
      .set('Authorization', await globalToken())
      .expect(204);

    expect(response.text).toBe('');
    await expect(providerRow('app-b', 'facebook')).resolves.toBeNull();
  });

  it('audits updates and deletes with provider only, never the secret or clientKey', async () => {
    const events = await prisma.auditEvent.findMany({
      where: { action: { in: ['social-provider.update', 'social-provider.delete'] } },
      orderBy: { occurredAt: 'asc' },
    });

    expect(events.some((event) => event.action === 'social-provider.update')).toBe(true);
    expect(events.some((event) => event.action === 'social-provider.delete')).toBe(true);
    const clientIds = new Set([appAInternalId, appBInternalId]);
    expect(events.every((event) => event.clientId !== null && clientIds.has(event.clientId))).toBe(
      true,
    );

    for (const event of events) {
      expect(event.targetType).toBe('social_provider');
      expect(event.metadata).toMatchObject({ provider: expect.any(String) });
      const metadata = jsonOf(event.metadata);
      expect(metadata).not.toContain(appASecret);
      expect(metadata).not.toContain(appASecretRotated);
      expect(metadata).not.toContain(appBSecret);
      expect(metadata).not.toContain('app-a-google-key');
      expect(metadata).not.toContain('app-b-facebook-key');
      expect(metadata).not.toContain('clientSecret');
    }

    const deleted = events.find((event) => event.action === 'social-provider.delete');
    expect(deleted?.clientId).not.toBeNull();
    expect(deleted?.targetId).not.toBeNull();
  });
});
