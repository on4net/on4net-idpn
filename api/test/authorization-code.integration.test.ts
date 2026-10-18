import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  exchangeAuthorizationCode,
  hashCode,
  issueAuthorizationCode,
  s256Challenge,
} from '../src/oidc/authorization-code.js';
import { createPrismaCodeRepository } from '../src/oidc/prisma-code-repository.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';

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
    scratchDatabase = `idpn_code_${Date.now()}`;
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
    data: { slug: `code-tenant-${Date.now()}`, name: 'Code tenant' },
  });
  const client = await prisma.client.create({
    data: {
      clientId: `code-client-${Date.now()}`,
      name: 'Code client',
      type: 'spa',
      redirectUris: ['https://app.example.com/cb'],
      postLogoutRedirectUris: [],
      allowedOrigins: [],
      scopes: ['openid'],
      allowedEmailDomains: [],
      tenantId: tenant.id,
    },
  });
  clientId = client.id;
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: `codeuser${Date.now()}`,
      email: `code${Date.now()}@example.com`,
      displayName: 'Code User',
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

describe('Prisma authorization code repository', () => {
  it('persists a hashed code and consumes it exactly once', async () => {
    const repository = createPrismaCodeRepository(prisma);
    const now = new Date('2026-10-18T10:00:00Z');

    const { code } = await issueAuthorizationCode(repository, {
      clientId,
      userId,
      sessionId,
      redirectUri: 'https://app.example.com/cb',
      scope: ['openid'],
      nonce: 'nonce',
      codeChallenge: s256Challenge(verifier),
      authTime: now,
      acr: 'urn:on4net:acr:pwd',
      amr: ['pwd'],
      now,
    });

    const row = await prisma.authorizationCode.findUniqueOrThrow({
      where: { codeHash: hashCode(code) },
    });
    expect(row.codeHash).not.toBe(code);
    expect(row.consumedAt).toBeNull();
    expect(row.nonce).toBe('nonce');

    const first = await exchangeAuthorizationCode(repository, {
      code,
      clientId,
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: verifier,
      now,
    });
    expect(first.ok).toBe(true);

    const second = await exchangeAuthorizationCode(repository, {
      code,
      clientId,
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: verifier,
      now,
    });
    expect(second).toEqual({ ok: false, reason: 'code_already_used' });
  }, 60_000);

  it('does not consume a code when the PKCE verifier is wrong', async () => {
    const repository = createPrismaCodeRepository(prisma);
    const now = new Date('2026-10-18T10:00:00Z');

    const { code } = await issueAuthorizationCode(repository, {
      clientId,
      userId,
      sessionId,
      redirectUri: 'https://app.example.com/cb',
      scope: ['openid'],
      codeChallenge: s256Challenge(verifier),
      authTime: now,
      acr: 'urn:on4net:acr:pwd',
      amr: ['pwd'],
      now,
    });

    const result = await exchangeAuthorizationCode(repository, {
      code,
      clientId,
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: 'b'.repeat(64),
      now,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_grant' });

    // A failed PKCE check must leave the code usable for the legitimate holder.
    const retry = await exchangeAuthorizationCode(repository, {
      code,
      clientId,
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: verifier,
      now,
    });
    expect(retry.ok).toBe(true);
  }, 60_000);
});
