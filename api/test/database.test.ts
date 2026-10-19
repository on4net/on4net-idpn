import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { rollbackLatestMigration } from '../src/db/rollback.js';
import { seedDatabase } from '../prisma/seed.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const EXPECTED_TABLES = [
  'tenants',
  'users',
  'identities',
  'clients',
  'client_secrets',
  'client_social_providers',
  'client_login_contexts',
  'client_memberships',
  'permissions',
  'roles',
  'role_permissions',
  'assignments',
  'sessions',
  'authorization_codes',
  'refresh_tokens',
  'consents',
  'audit_events',
  'signing_keys',
];

let container: StartedPostgreSqlContainer | undefined;
let connectionString: string;
let client: Client;
let scratchDatabase: string | undefined;
let serverClient: Client | undefined;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString },
  });
}

async function expectSqlError(sql: string, parameters: unknown[], code: string): Promise<void> {
  await client.query('SAVEPOINT expected_failure');
  await expect(client.query(sql, parameters)).rejects.toMatchObject({ code });
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
}

async function inTransaction(run: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await run();
  } finally {
    await client.query('ROLLBACK');
  }
}

async function insertTenant(slug = 'test-tenant'): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, 'Test tenant'],
  );
  const tenant = rows[0];
  if (tenant === undefined) {
    throw new Error('failed to insert tenant');
  }
  return tenant.id;
}

async function insertUser(tenantId: string, email = 'tester@example.com'): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (tenant_id, username, email, display_name, updated_at)
     VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [tenantId, email.split('@')[0], email, 'Tester'],
  );
  const user = rows[0];
  if (user === undefined) {
    throw new Error('failed to insert user');
  }
  return user.id;
}

beforeAll(async () => {
  const externalServer = process.env.TEST_DATABASE_URL;
  if (externalServer !== undefined && externalServer !== '') {
    // Local/CI shortcut: run against a temporary database on an existing server.
    scratchDatabase = `idpn_test_${Date.now()}`;
    serverClient = new Client({ connectionString: externalServer });
    await serverClient.connect();
    await serverClient.query(`CREATE DATABASE "${scratchDatabase}"`);
    const url = new URL(externalServer);
    url.pathname = `/${scratchDatabase}`;
    connectionString = url.toString();
  } else {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(180_000)
      .start();
    connectionString = container.getConnectionUri();
  }

  await migrateDeploy();
  client = new Client({ connectionString });
  await client.connect();
}, 300_000);

afterAll(async () => {
  await client?.end();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

describe('initial schema', () => {
  it('creates every table documented in the domain model', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const tables = new Set(rows.map((row) => row.table_name));

    for (const table of EXPECTED_TABLES) {
      expect(tables.has(table), `missing table ${table}`).toBe(true);
    }
  });

  it('enforces case-insensitive email and username values', async () => {
    await inTransaction(async () => {
      const tenantId = await insertTenant();
      await expectSqlError(
        `INSERT INTO users (tenant_id, username, email, display_name, updated_at)
         VALUES ($1, 'mixed', 'Mixed@Example.com', 'Mixed', now())`,
        [tenantId],
        '23514',
      );
    });
  });

  it('enforces tenant-scoped email uniqueness', async () => {
    await inTransaction(async () => {
      const tenantId = await insertTenant();
      await insertUser(tenantId, 'duplicate@example.com');
      await expectSqlError(
        `INSERT INTO users (tenant_id, username, email, display_name, updated_at)
         VALUES ($1, 'duplicate', 'duplicate@example.com', 'Duplicate', now())`,
        [tenantId],
        '23505',
      );
    });
  });

  it('enforces a single membership per client, context and user', async () => {
    await inTransaction(async () => {
      const tenantId = await insertTenant();
      const userId = await insertUser(tenantId);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO clients (client_id, name, type, redirect_uris, post_logout_redirect_uris,
                              allowed_origins, scopes, allowed_email_domains, tenant_id, updated_at)
         VALUES ('app-a', 'App A', 'web', '{}', '{}', '{}', '{openid}', '{}', $1, now())
         RETURNING id`,
        [tenantId],
      );
      const clientRow = rows[0];
      if (clientRow === undefined) {
        throw new Error('failed to insert client');
      }

      await client.query(
        `INSERT INTO client_memberships (client_id, user_id, status, updated_at)
         VALUES ($1, $2, 'active', now())`,
        [clientRow.id, userId],
      );
      await expectSqlError(
        `INSERT INTO client_memberships (client_id, user_id, status, updated_at)
         VALUES ($1, $2, 'active', now())`,
        [clientRow.id, userId],
        '23505',
      );
    });
  });

  it('allows at most one default login context per client', async () => {
    await inTransaction(async () => {
      const tenantId = await insertTenant();
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO clients (client_id, name, type, redirect_uris, post_logout_redirect_uris,
                              allowed_origins, scopes, allowed_email_domains, tenant_id, updated_at)
         VALUES ('app-b', 'App B', 'web', '{}', '{}', '{}', '{openid}', '{}', $1, now())
         RETURNING id`,
        [tenantId],
      );
      const clientRow = rows[0];
      if (clientRow === undefined) {
        throw new Error('failed to insert client');
      }

      const insertContext = (key: string, isDefault: boolean) =>
        client.query(
          `INSERT INTO client_login_contexts
             (client_id, key, name, is_default, allowed_roles, default_roles, login_methods,
              allowed_email_domains, session_idle_ttl, session_absolute_ttl, updated_at)
           VALUES ($1, $2, $3, $4, '{}', '{}', '{password}', '{}', 1800, 28800, now())`,
          [clientRow.id, key, key, isDefault],
        );

      await insertContext('customer', true);
      await expectSqlError(
        `INSERT INTO client_login_contexts
           (client_id, key, name, is_default, allowed_roles, default_roles, login_methods,
            allowed_email_domains, session_idle_ttl, session_absolute_ttl, updated_at)
         VALUES ($1, 'platform', 'platform', true, '{}', '{}', '{password}', '{}', 1800, 28800, now())`,
        [clientRow.id],
        '23505',
      );
    });
  });

  it('keeps assignment scope consistent with its scope type', async () => {
    await inTransaction(async () => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO roles (key, name, description, updated_at)
         VALUES ('app-a:admin', 'App A Admin', 'App A admin role', now())
         RETURNING id`,
      );
      const role = rows[0];
      if (role === undefined) {
        throw new Error('failed to insert role');
      }

      await expectSqlError(
        `INSERT INTO assignments (subject_type, subject_id, role_id, scope_type, scope_id, assigned_by)
         VALUES ('user', gen_random_uuid(), $1, 'organization', NULL, gen_random_uuid())`,
        [role.id],
        '23514',
      );
      await expectSqlError(
        `INSERT INTO assignments (subject_type, subject_id, role_id, scope_type, scope_id, assigned_by)
         VALUES ('user', gen_random_uuid(), $1, 'global', gen_random_uuid(), gen_random_uuid())`,
        [role.id],
        '23514',
      );
    });
  });

  it('restricts deleting a tenant that still owns users', async () => {
    await inTransaction(async () => {
      const tenantId = await insertTenant();
      await insertUser(tenantId);
      await expectSqlError('DELETE FROM tenants WHERE id = $1', [tenantId], '23503');
    });
  });

  it('rolls back and re-applies the migrations', async () => {
    const latest = await rollbackLatestMigration({ connectionString });
    expect(latest).toBe('0002_assignments_nulls_not_distinct');
    const rolledBack = await rollbackLatestMigration({ connectionString });
    expect(rolledBack).toBe('0001_init');

    const afterRollback = await client.query<{ users: string | null }>(
      `SELECT to_regclass('public.users') AS users`,
    );
    expect(afterRollback.rows[0]?.users).toBeNull();

    await migrateDeploy();

    const afterReapply = await client.query<{ users: string | null }>(
      `SELECT to_regclass('public.users') AS users`,
    );
    expect(afterReapply.rows[0]?.users).not.toBeNull();
  }, 240_000);

  it('seeding twice does not duplicate data', async () => {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
    try {
      await seedDatabase(prisma);
      const first = await countSeededRows(prisma);
      await seedDatabase(prisma);
      const second = await countSeededRows(prisma);

      expect(second).toEqual(first);
      expect(first.tenants).toBe(1);
      expect(first.clients).toBe(1);
      expect(first.users).toBe(3);
      expect(first.roles).toBe(6);
      expect(first.permissions).toBe(27);
      expect(first.assignments).toBe(2);
      expect(first.rolePermissions).toBeGreaterThan(0);
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);
});

async function countSeededRows(prisma: PrismaClient): Promise<{
  tenants: number;
  clients: number;
  users: number;
  roles: number;
  permissions: number;
  assignments: number;
  rolePermissions: number;
}> {
  const [tenants, clients, users, roles, permissions, assignments, rolePermissions] =
    await Promise.all([
      prisma.tenant.count(),
      prisma.client.count(),
      prisma.user.count(),
      prisma.role.count(),
      prisma.permission.count(),
      prisma.assignment.count(),
      prisma.rolePermission.count(),
    ]);

  return { tenants, clients, users, roles, permissions, assignments, rolePermissions };
}
