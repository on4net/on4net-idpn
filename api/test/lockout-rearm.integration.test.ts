import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  LOCK_DURATION_MS,
  MAX_FAILED_ATTEMPTS,
  isAccountLocked,
  nextFailureState,
} from '../src/login/lockout.js';
import { createPrismaLoginRepository } from '../src/login/prisma-repository.js';
import { createPrismaMfaRepository } from '../src/mfa/prisma-repository.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let prisma: PrismaClient;
let tenantId: string;

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  let connectionString: string;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_lockout_${Date.now()}`;
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
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString },
  });
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  tenantId = (await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } })).id;
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
  if (serverClient !== undefined) {
    if (scratchDatabase !== undefined) {
      await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    }
    await serverClient.end();
  }
});

const makeUser = (name: string) =>
  prisma.user.create({
    data: {
      tenantId,
      username: name,
      email: `${name}@example.com`,
      displayName: name,
      status: 'active',
    },
  });

/** One wrong credential exactly as the routes do it: read, compute, persist. */
async function fail(
  userId: string,
  at: Date,
  persist: (id: string, attempts: number, until: Date | null) => Promise<void>,
): Promise<void> {
  const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const next = nextFailureState(row, at);
  await persist(userId, next.attempts, next.lockedUntil);
}

describe('lockout re-arms after the first lock expires (card #18)', () => {
  type Persist = (id: string, attempts: number, until: Date | null) => Promise<void>;
  const required = (persist: Persist | undefined): Persist => {
    if (persist === undefined) {
      throw new Error('repository has no registerFailedAttempt');
    }
    return persist;
  };
  const stores: Record<string, () => Persist> = {
    login: () => required(createPrismaLoginRepository(prisma).registerFailedAttempt),
    mfa: () => required(createPrismaMfaRepository(prisma).registerFailedAttempt),
  };

  for (const [name, pick] of Object.entries(stores)) {
    it(`${name}: lock, expiry, then five more failures lock the account again`, async () => {
      const persist = pick();
      const user = await makeUser(`lock-${name}`);
      const start = new Date();

      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
        await fail(user.id, start, persist);
      }
      const first = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(isAccountLocked(first.lockedUntil, start)).toBe(true);

      const afterExpiry = new Date(start.getTime() + LOCK_DURATION_MS + 1_000);
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
        await fail(user.id, afterExpiry, persist);
      }
      const second = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(isAccountLocked(second.lockedUntil, afterExpiry)).toBe(true);
      expect(second.lockedUntil!.getTime()).toBeGreaterThan(first.lockedUntil!.getTime());
    });
  }
});
