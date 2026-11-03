import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedDatabase } from '../src/db/catalog.js';
import { createPrismaSetupStore } from '../src/setup/prisma-store.js';
import type { InstallInput } from '../src/setup/setup-types.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionString: string;

const input = (overrides: Partial<InstallInput> = {}): InstallInput => ({
  username: 'root',
  email: 'root@example.com',
  displayName: 'Root',
  passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$aaaa$bbbb',
  ...overrides,
});

async function migrate(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString },
  });
}

async function freshDatabase(): Promise<{ prisma: PrismaClient; sql: Client }> {
  const name = `idpn_install_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  if (serverClient === undefined) {
    throw new Error('server not started');
  }
  await serverClient.query(`CREATE DATABASE "${name}"`);
  const url = new URL(baseUrl());
  url.pathname = `/${name}`;
  connectionString = url.toString();
  await migrate();
  const sql = new Client({ connectionString });
  await sql.connect();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return { prisma, sql };
}

function baseUrl(): string {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    return external;
  }
  if (container === undefined) {
    throw new Error('container not started');
  }
  return container.getConnectionUri();
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external === undefined || external === '') {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(180_000)
      .start();
  }
  serverClient = new Client({ connectionString: baseUrl() });
  await serverClient.connect();
  scratchDatabase = undefined;
}, 240_000);

afterAll(async () => {
  await serverClient?.end();
  await container?.stop();
  void scratchDatabase;
});

describe('install wizard store (PostgreSQL)', () => {
  it('installs once: catalog, superadmin, marker and audit land together', async () => {
    const { prisma, sql } = await freshDatabase();
    try {
      const store = createPrismaSetupStore(prisma);
      expect(await store.isInstalled()).toBe(false);

      const outcome = await store.install(input({ adminUrl: 'https://admin.example.com' }));
      expect(outcome.ok).toBe(true);
      expect(await store.isInstalled()).toBe(true);

      const users = await sql.query<{ email: string; password_hash: string; status: string }>(
        `SELECT email, password_hash, status FROM users`,
      );
      // Only the administrator: the development fixtures are not created.
      expect(users.rows).toEqual([
        expect.objectContaining({ email: 'root@example.com', status: 'active' }),
      ]);
      expect(users.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);

      const roles = await sql.query<{ key: string }>(
        `SELECT r.key FROM assignments a JOIN roles r ON r.id = a.role_id`,
      );
      expect(roles.rows.map((row) => row.key)).toEqual(['idp:superadmin']);

      const client = await sql.query<{ redirect_uris: string[]; allowed_origins: string[] }>(
        `SELECT redirect_uris, allowed_origins FROM clients WHERE client_id = 'admin-panel'`,
      );
      expect(client.rows[0]?.redirect_uris).toEqual(['https://admin.example.com/auth/callback']);
      expect(client.rows[0]?.allowed_origins).toEqual(['https://admin.example.com']);

      const marker = await sql.query<{ source: string; installed_by: string | null }>(
        `SELECT source, installed_by FROM system_install`,
      );
      expect(marker.rows).toHaveLength(1);
      expect(marker.rows[0]?.source).toBe('wizard');
      expect(marker.rows[0]?.installed_by).not.toBeNull();

      const audit = await sql.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'setup.install'`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain('root@example.com');

      // The wizard is closed for good, even for a different administrator.
      const second = await store.install(input({ username: 'other', email: 'other@example.com' }));
      expect(second).toEqual({ ok: false, reason: 'already_installed' });
      const count = await sql.query<{ n: string }>(`SELECT count(*) AS n FROM users`);
      expect(count.rows[0]?.n).toBe('1');
    } finally {
      await sql.end();
      await prisma.$disconnect();
    }
  }, 240_000);

  it('lets exactly one of several concurrent completions win', async () => {
    const { prisma, sql } = await freshDatabase();
    try {
      const store = createPrismaSetupStore(prisma);
      const results = await Promise.all(
        [1, 2, 3, 4].map((n) =>
          store.install(input({ username: `admin${n}`, email: `admin${n}@example.com` })),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(
        results.filter((result) => !result.ok && result.reason === 'already_installed'),
      ).toHaveLength(3);
      const users = await sql.query<{ n: string }>(`SELECT count(*) AS n FROM users`);
      expect(users.rows[0]?.n).toBe('1');
    } finally {
      await sql.end();
      await prisma.$disconnect();
    }
  }, 240_000);

  it('rolls everything back on a conflict and leaves the wizard open', async () => {
    const { prisma, sql } = await freshDatabase();
    try {
      await seedDatabase(prisma);
      await sql.query(
        `UPDATE users SET password_hash = '$argon2id$x' WHERE email = 'support@example.com'`,
      );
      // The seed marks nothing installed by itself, but a credentialed account now exists.
      await sql.query(`DELETE FROM system_install`);

      const store = createPrismaSetupStore(prisma);
      const outcome = await store.install(
        input({ username: 'support', email: 'support@example.com' }),
      );
      expect(outcome).toEqual({ ok: false, reason: 'conflict' });
      expect(await store.isInstalled()).toBe(false);
    } finally {
      await sql.end();
      await prisma.$disconnect();
    }
  }, 240_000);

  it('adopts a credential-less seed user instead of failing', async () => {
    const { prisma, sql } = await freshDatabase();
    try {
      await seedDatabase(prisma);
      await sql.query(`DELETE FROM system_install`);
      const store = createPrismaSetupStore(prisma);
      const outcome = await store.install(
        input({ username: 'admin', email: 'admin@example.com', displayName: 'Real Admin' }),
      );
      expect(outcome.ok).toBe(true);
      const row = await sql.query<{ display_name: string; password_hash: string }>(
        `SELECT display_name, password_hash FROM users WHERE email = 'admin@example.com'`,
      );
      expect(row.rows[0]?.display_name).toBe('Real Admin');
      expect(row.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    } finally {
      await sql.end();
      await prisma.$disconnect();
    }
  }, 240_000);

  it('migration marks an already running instance as installed', async () => {
    const { prisma, sql } = await freshDatabase();
    try {
      // Simulate upgrading: a credentialed user exists before 0020 runs.
      await sql.query(`DROP TABLE system_install`);
      await seedDatabase(prisma);
      await sql.query(`UPDATE users SET password_hash = '$argon2id$x' WHERE username = 'admin'`);
      const migrationSql = await import('node:fs/promises').then((fs) =>
        fs.readFile(
          new URL('../prisma/migrations/0020_system_install/migration.sql', import.meta.url),
          'utf8',
        ),
      );
      await sql.query(migrationSql);
      const marker = await sql.query<{ source: string }>(`SELECT source FROM system_install`);
      expect(marker.rows).toEqual([{ source: 'existing' }]);
      expect(await createPrismaSetupStore(prisma).isInstalled()).toBe(true);
    } finally {
      await sql.end();
      await prisma.$disconnect();
    }
  }, 240_000);
});
