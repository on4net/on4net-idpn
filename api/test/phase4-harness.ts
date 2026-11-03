import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import { Client } from 'pg';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';

/**
 * Shared infrastructure for the phase-4 regression suites.
 *
 * Each suite owns a scratch PostgreSQL database (so the tests can run against an external
 * server without sharing state) and its own Redis connection. Social providers and mail stay
 * fake, so no test opens a socket to a real provider (`docs/testing.md` 5.1).
 */

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

export interface Phase4Infra {
  prisma: PrismaClient;
  redis: Redis;
  keys: SigningKeyManager;
  tenantId: string;
  connectionString: string;
  close(): Promise<void>;
}

async function migrateDeploy(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString },
  });
}

/** Removes only the keys this suite namespaces under, never the whole database. */
async function deleteKeysByPrefix(redis: Redis, prefix: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== '0');
}

export async function startPhase4Infra(prefix: string): Promise<Phase4Infra> {
  let postgres: StartedPostgreSqlContainer | undefined;
  let redisContainer: StartedRedisContainer | undefined;
  let serverClient: Client | undefined;
  let scratchDatabase: string | undefined;
  let connectionStringValue: string;

  const externalDatabase = process.env.TEST_DATABASE_URL;
  if (externalDatabase !== undefined && externalDatabase !== '') {
    scratchDatabase = `${prefix}_${Date.now()}_${randomBytes(4).toString('hex')}`;
    serverClient = new Client({ connectionString: externalDatabase });
    await serverClient.connect();
    await serverClient.query(`CREATE DATABASE "${scratchDatabase}"`);
    const url = new URL(externalDatabase);
    url.pathname = `/${scratchDatabase}`;
    connectionStringValue = url.toString();
  } else {
    postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(180_000)
      .start();
    connectionStringValue = postgres.getConnectionUri();
  }
  await migrateDeploy(connectionStringValue);

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionStringValue }),
  });

  let redis: Redis;
  const externalRedis = process.env.TEST_REDIS_URL;
  if (externalRedis !== undefined && externalRedis !== '') {
    // A separate logical database keeps this suite's keys away from other local data while
    // still exercising the real Redis serialization and TTL behaviour. The index is derived
    // from the process id instead of `Math.random()` so two suites can never pick the same
    // database and flush each other's keys.
    const url = new URL(externalRedis);
    url.pathname = `/${7 + (process.pid % 8)}`;
    redis = new Redis(url.toString());
  } else {
    redisContainer = await new RedisContainer('redis:7-alpine').withStartupTimeout(180_000).start();
    redis = new Redis(redisContainer.getConnectionUrl());
  }
  // Only this suite's keys are removed: `flushdb` would wipe whatever else an operator keeps
  // in the shared database.
  await deleteKeysByPrefix(redis, 'idpn:');

  const keys = new SigningKeyManager(new MemorySigningKeyRepository());
  await keys.ensureKey();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });

  return {
    prisma,
    redis,
    keys,
    tenantId: tenant.id,
    connectionString: connectionStringValue,
    async close() {
      await redis.quit();
      await redisContainer?.stop();
      await prisma.$disconnect();
      if (scratchDatabase !== undefined && serverClient !== undefined) {
        await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
        await serverClient.end();
      }
      await postgres?.stop();
    },
  };
}
