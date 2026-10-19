import { MESSAGES } from '@idpn/i18n';
import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaAdminTranslationRepository } from '../src/admin/translations/prisma-translation-repository.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { buildServer } from '../src/server.js';
import { bundleCacheKey, createRedisBundleCache } from '../src/translations/cache.js';
import { createPrismaPublicTranslationRepository } from '../src/translations/prisma-repository.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3100';
const adminClientId = 'admin-panel';
const suffix = Date.now().toString(36);
const APP_A = `app-a-${suffix}`;
const APP_B = `app-b-${suffix}`;

let container: StartedPostgreSqlContainer | undefined;
let redisContainer: StartedRedisContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let prisma: PrismaClient;
let redis: Redis;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let adminUserId: string;
let delegatedAUserId: string;
let delegatedBUserId: string;
let readerUserId: string;
let appAId: string;
let appBId: string;

const connectionString = (): string => connectionStringValue;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

const globalToken = async (userId: string, scope = 'openid idp.admin'): Promise<string> => {
  const accessToken = await keys.signAccessToken(
    { scope, client_id: adminClientId },
    { issuer, audience: adminClientId, subject: userId, expiresInSeconds: 300 },
  );
  return `Bearer ${accessToken}`;
};

const delegatedToken = async (userId: string, clientId: string): Promise<string> => {
  const accessToken = await keys.signAccessToken(
    { scope: 'openid idp.client-admin', client_id: clientId },
    { issuer, audience: clientId, subject: userId, expiresInSeconds: 300 },
  );
  return `Bearer ${accessToken}`;
};

const locales = (overrides: Record<string, unknown> = {}) => ({
  default: 'fa-IR',
  supported: ['fa-IR', 'en-US'],
  dir: { 'fa-IR': 'rtl', 'en-US': 'ltr' },
  calendar: 'persian',
  version: '2026-10-19T08:00:00.000Z',
  ...overrides,
});

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_translations_${Date.now()}`;
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

  const externalRedis = process.env.TEST_REDIS_URL;
  if (externalRedis !== undefined && externalRedis !== '') {
    redis = new Redis(externalRedis);
  } else {
    redisContainer = await new RedisContainer('redis:7-alpine').withStartupTimeout(180_000).start();
    redis = new Redis(redisContainer.getConnectionUrl());
  }

  keys = new SigningKeyManager(new MemorySigningKeyRepository());
  await keys.ensureKey();

  const permissionReader = createPrismaPermissionReader(prisma);
  const cache = createRedisBundleCache(redis);
  app = buildServer({
    issuer,
    keys,
    translations: {
      repository: createPrismaPublicTranslationRepository(prisma),
      cache,
      allowedOrigins: async () => [],
    },
    adminTranslations: {
      adminClientId,
      permissions: permissionReader,
      translations: createPrismaAdminTranslationRepository(prisma),
      audit: createPrismaAdminAudit(prisma),
      cache,
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  const makeClient = async (clientId: string, scopes: string[], localeConfig: unknown) =>
    prisma.client.create({
      data: {
        clientId,
        name: clientId,
        type: 'web',
        redirectUris: [],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes,
        locales: localeConfig as never,
        tenantId: tenant.id,
      },
    });
  await makeClient(adminClientId, ['openid', 'idp.admin'], {});
  const appA = await makeClient(APP_A, ['openid', 'idp.client-admin'], locales());
  const appB = await makeClient(APP_B, ['openid', 'idp.client-admin'], locales());
  appAId = appA.id;
  appBId = appB.id;

  const permissionKeys = ['idp:client-locale:read', 'idp:client-locale:write'];
  const permissionRows = new Map<string, string>();
  for (const key of permissionKeys) {
    const row = await prisma.permission.create({ data: { key, description: key } });
    permissionRows.set(key, row.id);
  }

  const makeRole = async (key: string, clientId: string | null, keys: string[]) =>
    prisma.role.create({
      data: {
        key,
        name: key,
        description: key,
        ...(clientId === null ? {} : { clientId }),
        rolePermissions: {
          create: keys.map((permission) => ({ permissionId: permissionRows.get(permission)! })),
        },
      },
    });

  const adminRole = await makeRole('translation-admin', null, permissionKeys);
  const appARole = await makeRole('app-a-translation-admin', appAId, permissionKeys);
  const appBRole = await makeRole('app-b-translation-admin', appBId, permissionKeys);
  const readerRole = await makeRole('translation-reader', null, ['idp:client-locale:read']);

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
  const reader = await makeUser('reader');
  adminUserId = admin.id;
  delegatedAUserId = delegatedA.id;
  delegatedBUserId = delegatedB.id;
  readerUserId = reader.id;

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
        roleId: appARole.id,
        scopeType: 'global',
        assignedBy: admin.id,
      },
      {
        subjectType: 'user',
        subjectId: delegatedB.id,
        roleId: appBRole.id,
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
  await redis?.quit();
  await redisContainer?.stop();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

describe('translation authorization', () => {
  it('requires a token', async () => {
    await request(app.server).get(`/api/v1/clients/${APP_A}/locales`).expect(401);
  });

  it('lets a delegated admin only touch its own client', async () => {
    const token = await delegatedToken(delegatedAUserId, APP_A);

    await request(app.server)
      .get(`/api/v1/clients/${APP_A}/locales`)
      .set('Authorization', token)
      .expect(200);

    await request(app.server)
      .get(`/api/v1/clients/${APP_B}/locales`)
      .set('Authorization', token)
      .expect(403);

    await request(app.server)
      .put(`/api/v1/clients/${APP_B}/translations/fa-IR`)
      .set('Authorization', token)
      .send({ messages: { 'login.title': 'cross client' } })
      .expect(403);

    const otherToken = await delegatedToken(delegatedBUserId, APP_B);
    await request(app.server)
      .get(`/api/v1/clients/${APP_A}/locales`)
      .set('Authorization', otherToken)
      .expect(403);
  });

  it('requires the write permission for writes', async () => {
    const token = await globalToken(readerUserId);
    const response = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/locales`)
      .set('Authorization', token)
      .send({ default: 'fa-IR', supported: ['fa-IR'] })
      .expect(403);
    expect(response.body.type).toContain('/forbidden');
  });
});

describe('locale settings', () => {
  it('returns the normalized settings', async () => {
    const response = await request(app.server)
      .get(`/api/v1/clients/${APP_A}/locales`)
      .set('Authorization', await globalToken(adminUserId))
      .expect(200);
    expect(response.body).toMatchObject({
      default: 'fa-IR',
      supported: ['fa-IR', 'en-US'],
      calendar: 'persian',
      dir: { 'fa-IR': 'rtl', 'en-US': 'ltr' },
    });
  });

  it('rejects a default outside supported, empty support and an unknown calendar', async () => {
    const token = await globalToken(adminUserId);

    const defaultProblem = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/locales`)
      .set('Authorization', token)
      .send({ default: 'de-DE', supported: ['fa-IR', 'en-US'] })
      .expect(422);
    expect(defaultProblem.body.detail).toContain('must be one of the supported locales');

    const empty = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/locales`)
      .set('Authorization', token)
      .send({ default: 'fa-IR', supported: [] })
      .expect(422);
    expect(empty.body.detail).toContain('at least one locale is required');

    const malformed = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/locales`)
      .set('Authorization', token)
      .send({ default: 'fa IR', supported: ['fa-IR'] })
      .expect(422);
    expect(malformed.body.detail).toContain('BCP-47');

    const calendar = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/locales`)
      .set('Authorization', token)
      .send({ default: 'fa-IR', supported: ['fa-IR'], calendar: 'islamic' })
      .expect(422);
    expect(calendar.body.detail).toContain('calendar');
  });

  it('updates settings, supports partial default changes and audits the change', async () => {
    const token = await globalToken(adminUserId);

    const full = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/locales`)
      .set('Authorization', token)
      .send({ default: 'en-US', supported: ['fa-IR', 'en-US'], calendar: 'gregorian' })
      .expect(200);
    expect(full.body).toMatchObject({
      default: 'en-US',
      supported: ['fa-IR', 'en-US'],
      calendar: 'gregorian',
      dir: { 'fa-IR': 'rtl', 'en-US': 'ltr' },
    });

    const partial = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/locales`)
      .set('Authorization', token)
      .send({ default: 'fa-IR' })
      .expect(200);
    expect(partial.body.default).toBe('fa-IR');
    expect(partial.body.supported).toEqual(['fa-IR', 'en-US']);

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'client.locale.updated', targetId: appAId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit?.metadata).toMatchObject({
      clientId: APP_A,
      default: 'fa-IR',
      supported: ['fa-IR', 'en-US'],
      calendar: 'gregorian',
    });
  });
});

describe('translation CRUD, validation and audit', () => {
  it('INT-LOC-002: rejects unknown keys with 422 and the full list', async () => {
    const response = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', await globalToken(adminUserId))
      .send({ messages: { 'login.title': 'ورود', 'login.not.real': 'x' } })
      .expect(422);
    expect(response.body.detail).toContain('login.not.real');
  });

  it('rejects over-long values, markup and unknown placeholders', async () => {
    const token = await globalToken(adminUserId);

    const long = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', token)
      .send({ messages: { 'login.title': 'x'.repeat(501) } })
      .expect(422);
    expect(long.body.detail).toContain('at most 500');

    const markup = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', token)
      .send({ messages: { 'login.title': '<script>alert(1)</script>' } })
      .expect(422);
    expect(markup.body.detail).toContain('plain text');

    const placeholder = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', token)
      .send({ messages: { 'login.title': 'hi {adminToken}' } })
      .expect(422);
    expect(placeholder.body.detail).toContain('adminToken');
  });

  it('stores overrides, is idempotent and never audits message values', async () => {
    const token = await globalToken(adminUserId);
    const body = {
      messages: {
        'login.title': 'ورود به پنل مشتریان',
        'login.submit': 'ورود مشتری',
      },
    };

    const first = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', token)
      .send(body)
      .expect(200);
    expect(first.body.messages).toEqual(body.messages);
    expect(typeof first.body.version).toBe('string');

    const auditsAfterFirst = await prisma.auditEvent.count({
      where: { action: 'client.translation.updated', targetId: appAId },
    });

    const second = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', token)
      .send(body)
      .expect(200);
    expect(second.body.messages).toEqual(body.messages);
    await expect(
      prisma.auditEvent.count({
        where: { action: 'client.translation.updated', targetId: appAId },
      }),
    ).resolves.toBe(auditsAfterFirst);

    const list = await request(app.server)
      .get(`/api/v1/clients/${APP_A}/translations`)
      .set('Authorization', token)
      .expect(200);
    expect(list.body.locales).toContain('fa-IR');

    const detail = await request(app.server)
      .get(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', token)
      .expect(200);
    expect(detail.body.messages).toEqual(body.messages);

    const otherClient = await request(app.server)
      .get(`/api/v1/clients/${APP_B}/translations/fa-IR`)
      .set('Authorization', await globalToken(adminUserId))
      .expect(200);
    expect(otherClient.body.messages).toEqual({});

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'client.translation.updated', targetId: appAId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit?.metadata).toMatchObject({
      clientId: APP_A,
      locale: 'fa-IR',
      keys: ['login.submit', 'login.title'],
    });
    expect(JSON.stringify(audit?.metadata)).not.toContain('ورود به پنل مشتریان');
  });

  it('deletes an override when the value is empty', async () => {
    const token = await globalToken(adminUserId);
    const response = await request(app.server)
      .put(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', token)
      .send({ messages: { 'login.submit': '' } })
      .expect(200);
    expect(response.body.messages).not.toHaveProperty('login.submit');
    expect(response.body.messages['login.title']).toBe('ورود به پنل مشتریان');

    const detail = await request(app.server)
      .get(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', token)
      .expect(200);
    expect(detail.body.messages).not.toHaveProperty('login.submit');
  });

  it('rejects an unsupported locale and deletes all overrides for a locale', async () => {
    const token = await globalToken(adminUserId);

    await request(app.server)
      .put(`/api/v1/clients/${APP_A}/translations/de-DE`)
      .set('Authorization', token)
      .send({ messages: { 'login.title': 'x' } })
      .expect(422);

    await request(app.server)
      .delete(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', token)
      .expect(204);

    const detail = await request(app.server)
      .get(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', token)
      .expect(200);
    expect(detail.body.messages).toEqual({});
  });
});

describe('public bundle, cache and isolation', () => {
  it('INT-LOC-001 + INT-LOC-003: merges overrides and caches with ETag/304', async () => {
    await request(app.server)
      .put(`/api/v1/clients/${APP_A}/locales`)
      .set('Authorization', await globalToken(adminUserId))
      .send({ default: 'fa-IR', supported: ['fa-IR', 'en-US'], calendar: 'persian' })
      .expect(200);

    await request(app.server)
      .put(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', await globalToken(adminUserId))
      .send({ messages: { 'login.title': 'ورود به پنل مشتریان' } })
      .expect(200);

    const response = await request(app.server)
      .get(`/api/v1/clients/${APP_A}/translations/bundle?locale=fa-IR`)
      .expect(200);
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers.etag).toBeDefined();
    expect(response.headers['last-modified']).toBeDefined();
    expect(response.body).toMatchObject({ locale: 'fa-IR', dir: 'rtl', calendar: 'persian' });
    expect(response.body.messages['login.title']).toBe('ورود به پنل مشتریان');
    expect(response.body.messages['login.submit']).toBe(MESSAGES['fa-IR']['login.submit']);
    expect(Object.keys(response.body.messages).sort()).toEqual(
      Object.keys(MESSAGES['fa-IR']).sort(),
    );
    expect(JSON.stringify(response.body)).not.toContain('clientSecret');
    expect(JSON.stringify(response.body)).not.toContain('secretHash');
    expect(JSON.stringify(response.body)).not.toContain('redirectUris');

    await request(app.server)
      .get(`/api/v1/clients/${APP_A}/translations/bundle?locale=fa-IR`)
      .set('If-None-Match', String(response.headers.etag))
      .expect(304);
  });

  it('keeps the English base bundle free of Persian overrides', async () => {
    const response = await request(app.server)
      .get(`/api/v1/clients/${APP_A}/translations/bundle?locale=en-US`)
      .expect(200);
    expect(response.body.locale).toBe('en-US');
    expect(response.body.dir).toBe('ltr');
    expect(response.body.messages['login.title']).toBe(MESSAGES['en-US']['login.title']);
  });

  it('invalidates the Redis cache when an override is written', async () => {
    const key = bundleCacheKey(APP_A, 'fa-IR');
    await request(app.server)
      .get(`/api/v1/clients/${APP_A}/translations/bundle?locale=fa-IR`)
      .expect(200);
    await expect(redis.get(key)).resolves.not.toBeNull();

    await request(app.server)
      .put(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', await globalToken(adminUserId))
      .send({ messages: { 'login.submit': 'ورود مشتری' } })
      .expect(200);
    await expect(redis.get(key)).resolves.toBeNull();

    const response = await request(app.server)
      .get(`/api/v1/clients/${APP_A}/translations/bundle?locale=fa-IR`)
      .expect(200);
    expect(response.body.messages['login.submit']).toBe('ورود مشتری');
  });

  it('deletes to the base fallback in the bundle', async () => {
    await request(app.server)
      .delete(`/api/v1/clients/${APP_A}/translations/fa-IR`)
      .set('Authorization', await globalToken(adminUserId))
      .expect(204);

    const response = await request(app.server)
      .get(`/api/v1/clients/${APP_A}/translations/bundle?locale=fa-IR`)
      .expect(200);
    expect(response.body.messages['login.title']).toBe(MESSAGES['fa-IR']['login.title']);
    expect(response.body.messages['login.submit']).toBe(MESSAGES['fa-IR']['login.submit']);
  });

  it('does not leak another client override and ignores unsafe stored rows', async () => {
    await prisma.clientTranslation.create({
      data: {
        clientId: appBId,
        locale: 'fa-IR',
        key: 'login.title',
        value: '<script>alert(1)</script>',
      },
    });

    const response = await request(app.server)
      .get(`/api/v1/clients/${APP_B}/translations/bundle?locale=fa-IR`)
      .expect(200);
    expect(response.body.messages['login.title']).toBe(MESSAGES['fa-IR']['login.title']);
    expect(JSON.stringify(response.body)).not.toContain('<script>');

    const appA = await request(app.server)
      .get(`/api/v1/clients/${APP_A}/translations/bundle?locale=fa-IR`)
      .expect(200);
    expect(appA.body.messages['login.title']).toBe(MESSAGES['fa-IR']['login.title']);
  });

  it('returns a generic 404 for unknown clients, disabled clients and unsupported locales', async () => {
    const unknown = await request(app.server)
      .get('/api/v1/clients/does-not-exist/translations/bundle?locale=fa-IR')
      .expect(404);
    expect(unknown.body).toEqual({
      type: 'about:blank',
      title: 'Translations not found',
      status: 404,
    });

    const unsupported = await request(app.server)
      .get(`/api/v1/clients/${APP_A}/translations/bundle?locale=de-DE`)
      .expect(404);
    expect(JSON.stringify(unsupported.body)).not.toContain('fa-IR');

    await prisma.client.update({ where: { id: appBId }, data: { status: 'disabled' } });
    await request(app.server)
      .get(`/api/v1/clients/${APP_B}/translations/bundle?locale=fa-IR`)
      .expect(404);
  });
});
