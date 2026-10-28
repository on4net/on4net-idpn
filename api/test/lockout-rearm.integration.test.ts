import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { LOCK_DURATION_MS, MAX_FAILED_ATTEMPTS, isAccountLocked } from '../src/login/lockout.js';
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

type Persist = (id: string, attempts: number, until: Date | null) => Promise<void>;
const required = (persist: Persist | undefined): Persist => {
  if (persist === undefined) {
    throw new Error('repository has no registerFailedAttempt');
  }
  return persist;
};

/** The route-computed arguments are ignored by the stores; the database applies the policy. */
const fail = (persist: Persist, userId: string): Promise<void> => persist(userId, 0, null);

const state = (userId: string) => prisma.user.findUniqueOrThrow({ where: { id: userId } });

describe('account lockout is atomic and re-arms after expiry (card #18)', () => {
  const stores: Record<string, () => Persist> = {
    login: () => required(createPrismaLoginRepository(prisma).registerFailedAttempt),
    mfa: () => required(createPrismaMfaRepository(prisma).registerFailedAttempt),
  };

  for (const [name, pick] of Object.entries(stores)) {
    it(`${name}: lock, expiry, then five more failures lock the account again`, async () => {
      const persist = pick();
      const user = await makeUser(`lock-${name}`);

      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
        await fail(persist, user.id);
      }
      const first = await state(user.id);
      expect(isAccountLocked(first.lockedUntil, new Date())).toBe(true);

      // A failure during the lock neither counts nor slides the expiry.
      await fail(persist, user.id);
      const during = await state(user.id);
      expect(during.lockedUntil?.getTime()).toBe(first.lockedUntil?.getTime());
      expect(during.failedLoginCount).toBe(first.failedLoginCount);

      await prisma.user.update({
        where: { id: user.id },
        data: { lockedUntil: new Date(Date.now() - LOCK_DURATION_MS) },
      });
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
        await fail(persist, user.id);
      }
      const second = await state(user.id);
      expect(isAccountLocked(second.lockedUntil, new Date())).toBe(true);
    });

    it(`${name}: parallel guesses cannot undercount the failures`, async () => {
      const persist = pick();
      const user = await makeUser(`race-${name}`);
      await Promise.all(Array.from({ length: MAX_FAILED_ATTEMPTS }, () => fail(persist, user.id)));
      const row = await state(user.id);
      expect(row.failedLoginCount).toBe(MAX_FAILED_ATTEMPTS);
      expect(isAccountLocked(row.lockedUntil, new Date())).toBe(true);
    });
  }
});
