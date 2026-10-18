import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  hashRefreshToken,
  issueRefreshToken,
  rotateRefreshToken,
} from '../src/oidc/refresh-token.js';
import { createPrismaRefreshTokenRepository } from '../src/oidc/prisma-refresh-repository.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let prisma: PrismaClient;
let connectionString: string;
let clientId: string;
let userId: string;
let sessionId: string;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString },
  });
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_refresh_${Date.now()}`;
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

  const tenant = await prisma.tenant.create({
    data: { slug: `rt-tenant-${Date.now()}`, name: 'Refresh tenant' },
  });
  const client = await prisma.client.create({
    data: {
      clientId: `rt-client-${Date.now()}`,
      name: 'Refresh client',
      type: 'web',
      redirectUris: [],
      postLogoutRedirectUris: [],
      allowedOrigins: [],
      scopes: ['openid', 'offline_access'],
      allowedEmailDomains: [],
      tenantId: tenant.id,
    },
  });
  clientId = client.id;
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: `rtuser${Date.now()}`,
      email: `rt${Date.now()}@example.com`,
      displayName: 'Refresh User',
      status: 'active',
    },
  });
  userId = user.id;
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      idleExpiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 120_000),
      acr: 'urn:on4net:acr:pwd',
      amr: ['pwd'],
    },
  });
  sessionId = session.id;
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

const issue = (repository: ReturnType<typeof createPrismaRefreshTokenRepository>, at: Date) =>
  issueRefreshToken(repository, {
    clientId,
    userId,
    sessionId,
    scope: ['openid', 'offline_access'],
    ttlSeconds: 3600,
    now: at,
  });

describe('Prisma refresh token repository', () => {
  it('rotates a token and links it to its successor in the same family', async () => {
    const repository = createPrismaRefreshTokenRepository(prisma);
    const at = new Date('2026-10-18T10:00:00Z');
    const issued = await issue(repository, at);

    const rotation = await rotateRefreshToken(repository, {
      token: issued.token,
      clientId,
      ttlSeconds: 3600,
      now: new Date('2026-10-18T10:05:00Z'),
    });
    expect(rotation.ok).toBe(true);

    const old = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(issued.token) },
    });
    expect(old.rotatedAt).not.toBeNull();
    expect(old.replacedBy).not.toBeNull();

    const next = await prisma.refreshToken.findFirstOrThrow({
      where: { familyId: old.familyId, replacedBy: null },
    });
    expect(next.id).toBe(old.replacedBy);
    expect(next.familyId).toBe(old.familyId);
  }, 60_000);

  it('detects reuse and revokes the whole family', async () => {
    const repository = createPrismaRefreshTokenRepository(prisma);
    const at = new Date('2026-10-18T10:00:00Z');
    const issued = await issue(repository, at);

    await rotateRefreshToken(repository, {
      token: issued.token,
      clientId,
      ttlSeconds: 3600,
      now: new Date('2026-10-18T10:01:00Z'),
    });

    const reuse = await rotateRefreshToken(repository, {
      token: issued.token,
      clientId,
      ttlSeconds: 3600,
      now: new Date('2026-10-18T10:02:00Z'),
    });
    expect(reuse).toMatchObject({ ok: false, reason: 'reuse_detected' });
    if (!reuse.ok) {
      expect(reuse.revokedFamily).toBeGreaterThanOrEqual(2);
    }

    const family = await prisma.refreshToken.findMany({
      where: { tokenHash: hashRefreshToken(issued.token) },
    });
    expect(family[0]?.revokedAt).not.toBeNull();

    const all = await prisma.refreshToken.findMany({ where: { familyId: family[0]?.familyId } });
    expect(all.every((row) => row.revokedAt !== null)).toBe(true);
  }, 60_000);

  it('rejects an expired token', async () => {
    const repository = createPrismaRefreshTokenRepository(prisma);
    const issued = await issue(repository, new Date('2026-10-18T10:00:00Z'));

    const result = await rotateRefreshToken(repository, {
      token: issued.token,
      clientId,
      ttlSeconds: 3600,
      now: new Date('2026-10-18T12:00:00Z'),
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  }, 60_000);

  it('rejects a token presented by another client', async () => {
    const repository = createPrismaRefreshTokenRepository(prisma);
    const issued = await issue(repository, new Date('2026-10-18T10:00:00Z'));

    const result = await rotateRefreshToken(repository, {
      token: issued.token,
      clientId: 'another-client-id',
      ttlSeconds: 3600,
      now: new Date('2026-10-18T10:01:00Z'),
    });
    expect(result).toEqual({ ok: false, reason: 'client_mismatch' });
  }, 60_000);
});
