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
  'mfa_factors',
  'mfa_recovery_codes',
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

  it('allows one TOTP factor per user and cascades its recovery codes', async () => {
    await inTransaction(async () => {
      const tenantId = await insertTenant();
      const userId = await insertUser(tenantId);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO mfa_factors (user_id, type, secret_encrypted, confirmed_at)
         VALUES ($1, 'totp', '\\x00'::bytea, now()) RETURNING id`,
        [userId],
      );
      const factor = rows[0];
      if (factor === undefined) {
        throw new Error('failed to insert MFA factor');
      }

      await expectSqlError(
        `INSERT INTO mfa_factors (user_id, type) VALUES ($1, 'totp')`,
        [userId],
        '23505',
      );
      // WebAuthn authenticators are multiple per user, so the partial index must not apply.
      await client.query(
        `INSERT INTO mfa_factors (user_id, type, credential_id, public_key)
         VALUES ($1, 'webauthn', '\\x01'::bytea, '\\x02'::bytea)`,
        [userId],
      );
      await client.query(
        `INSERT INTO mfa_factors (user_id, type, credential_id, public_key)
         VALUES ($1, 'webauthn', '\\x03'::bytea, '\\x04'::bytea)`,
        [userId],
      );
      // The same authenticator credential cannot be enrolled twice (globally unique).
      await expectSqlError(
        `INSERT INTO mfa_factors (user_id, type, credential_id, public_key)
         VALUES ($1, 'webauthn', '\\x01'::bytea, '\\x09'::bytea)`,
        [userId],
        '23505',
      );

      await client.query(
        `INSERT INTO mfa_recovery_codes (factor_id, code_hash) VALUES ($1, 'hash')`,
        [factor.id],
      );
      await client.query('DELETE FROM mfa_factors WHERE id = $1', [factor.id]);
      const remaining = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM mfa_recovery_codes WHERE factor_id = $1`,
        [factor.id],
      );
      expect(remaining.rows[0]?.count).toBe('0');
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

  it('enforces the assignment tuple for global assignments', async () => {
    await inTransaction(async () => {
      const tenantId = await insertTenant();
      const userId = await insertUser(tenantId);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO roles (key, name, description, updated_at)
         VALUES ('app-a:global', 'App A Global', 'Global role', now())
         RETURNING id`,
      );
      const role = rows[0];
      if (role === undefined) {
        throw new Error('failed to insert role');
      }

      const insertAssignment = () =>
        client.query(
          `INSERT INTO assignments
             (subject_type, subject_id, role_id, scope_type, scope_id, assigned_by)
           VALUES ('user', $1, $2, 'global', NULL, $1)`,
          [userId, role.id],
        );

      await insertAssignment();
      // scope_id IS NULL must not make two global assignments distinct (migration 0002).
      await expectSqlError(
        `INSERT INTO assignments
           (subject_type, subject_id, role_id, scope_type, scope_id, assigned_by)
         VALUES ('user', $1, $2, 'global', NULL, $1)`,
        [userId, role.id],
        '23505',
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

  it('rejects updating and deleting audit events', async () => {
    await inTransaction(async () => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO audit_events (actor_type, action, result)
         VALUES ('system', 'test.append_only', 'success')
         RETURNING id`,
      );
      const event = rows[0];
      if (event === undefined) {
        throw new Error('failed to insert audit event');
      }

      await expectSqlError(
        `UPDATE audit_events SET action = 'tampered' WHERE id = $1`,
        [event.id],
        '42501',
      );
      await expectSqlError('DELETE FROM audit_events WHERE id = $1', [event.id], '42501');
    });
  });

  it('refuses to roll back without explicit confirmation', async () => {
    await expect(rollbackLatestMigration({ connectionString })).rejects.toThrow(
      /explicit confirmation/i,
    );
    const applied = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "_prisma_migrations" WHERE "rolled_back_at" IS NULL`,
    );
    expect(Number(applied.rows[0]?.count)).toBeGreaterThan(0);
  });

  it('rolls back and re-applies the migrations', async () => {
    const latest = await rollbackLatestMigration({ connectionString, confirm: true });
    expect(latest).toBe('0011_assignment_source_membership');
    const sourceColumn = await client.query<{ column: string | null }>(
      `SELECT column_name AS "column" FROM information_schema.columns
        WHERE table_name = 'assignments' AND column_name = 'source_membership_id'`,
    );
    expect(sourceColumn.rows[0]?.column ?? null).toBeNull();

    const second = await rollbackLatestMigration({ connectionString, confirm: true });
    expect(second).toBe('0010_missing_fk_indexes');
    const runtimeIndex = await client.query<{ indexname: string | null }>(
      `SELECT to_regclass('public.refresh_tokens_client_id_idx') AS indexname`,
    );
    expect(runtimeIndex.rows[0]?.indexname).toBeNull();

    const third = await rollbackLatestMigration({ connectionString, confirm: true });
    expect(third).toBe('0009_session_login_context');
    const contextColumn = await client.query<{ column: string | null }>(
      `SELECT column_name AS "column" FROM information_schema.columns
        WHERE table_name = 'sessions' AND column_name = 'login_context'`,
    );
    expect(contextColumn.rows[0]?.column ?? null).toBeNull();

    const fourth = await rollbackLatestMigration({ connectionString, confirm: true });
    expect(fourth).toBe('0008_client_translations');
    const translationTable = await client.query<{ translations: string | null }>(
      `SELECT to_regclass('public.client_translations') AS translations`,
    );
    expect(translationTable.rows[0]?.translations).toBeNull();

    const fifth = await rollbackLatestMigration({ connectionString, confirm: true });
    expect(fifth).toBe('0007_login_context_binding');
    const sixth = await rollbackLatestMigration({ connectionString, confirm: true });
    expect(sixth).toBe('0006_webauthn_credentials');
    const seventh = await rollbackLatestMigration({ connectionString, confirm: true });
    expect(seventh).toBe('0005_account_tokens');
    const eighth = await rollbackLatestMigration({ connectionString, confirm: true });
    expect(eighth).toBe('0004_mfa_factors');
    const ninth = await rollbackLatestMigration({ connectionString, confirm: true });
    expect(ninth).toBe('0003_audit_events_append_only');
    const tenth = await rollbackLatestMigration({ connectionString, confirm: true });
    expect(tenth).toBe('0002_assignments_nulls_not_distinct');
    const rolledBack = await rollbackLatestMigration({ connectionString, confirm: true });
    expect(rolledBack).toBe('0001_init');

    // The history is kept: a rolled-back migration is marked, not deleted (finding 3).
    const history = await client.query<{ migration_name: string; rolled_back_at: Date | null }>(
      `SELECT "migration_name", "rolled_back_at" FROM "_prisma_migrations"`,
    );
    expect(history.rows).toHaveLength(11);
    expect(history.rows.every((row) => row.rolled_back_at !== null)).toBe(true);

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
      expect(first.permissions).toBe(36);
      expect(first.loginContexts).toBe(1);
      expect(first.assignments).toBe(2);
      expect(first.rolePermissions).toBeGreaterThan(0);
      const adminClient = await prisma.client.findUnique({
        where: { clientId: 'admin-panel' },
        select: { defaultLoginContextKey: true },
      });
      expect(adminClient?.defaultLoginContextKey).toBe('default');
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
  loginContexts: number;
  assignments: number;
  rolePermissions: number;
}> {
  const [tenants, clients, users, roles, permissions, loginContexts, assignments, rolePermissions] =
    await Promise.all([
      prisma.tenant.count(),
      prisma.client.count(),
      prisma.user.count(),
      prisma.role.count(),
      prisma.permission.count(),
      prisma.clientLoginContext.count(),
      prisma.assignment.count(),
      prisma.rolePermission.count(),
    ]);

  return {
    tenants,
    clients,
    users,
    roles,
    permissions,
    loginContexts,
    assignments,
    rolePermissions,
  };
}
