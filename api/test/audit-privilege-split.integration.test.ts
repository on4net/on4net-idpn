import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildAuditSplitStatements,
  checkAuditPrivileges,
} from '../scripts/ops/audit-privileges.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let adminUrl = '';

const asRole = (role: string): string => {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = 'secret';
  return url.toString();
};

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

const insertAudit = (client: Client) =>
  client.query(
    `INSERT INTO "audit_events" ("id","actor_type","action","result","occurred_at")
     VALUES (gen_random_uuid(), 'system', 'test.event', 'success', now())`,
  );

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_audit_split_${Date.now()}`;
    serverClient = new Client({ connectionString: external });
    await serverClient.connect();
    await serverClient.query(`CREATE DATABASE "${scratchDatabase}"`);
    const url = new URL(external);
    url.pathname = `/${scratchDatabase}`;
    adminUrl = url.toString();
  } else {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(180_000)
      .start();
    adminUrl = container.getConnectionUri();
  }
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: adminUrl },
  });

  const admin = await connect(adminUrl);
  try {
    // The application role starts as the table owner's peer with full rights, like a default
    // deployment where the API role also ran the migrations.
    await admin.query(`CREATE ROLE "idpn_app_test" LOGIN PASSWORD 'secret'`);
    await admin.query(`CREATE ROLE "idpn_maint_test" LOGIN PASSWORD 'secret'`);
    const database = new URL(adminUrl).pathname.slice(1);
    await admin.query(`GRANT ALL ON DATABASE "${database}" TO "idpn_app_test", "idpn_maint_test"`);
    await admin.query(`GRANT ALL ON SCHEMA public TO "idpn_app_test", "idpn_maint_test"`);
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO "idpn_app_test"`);
  } finally {
    await admin.end();
  }
}, 300_000);

afterAll(async () => {
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

describe('audit privilege split', () => {
  it('reports every gap while the application role still owns or can rewrite the log', async () => {
    const admin = await connect(adminUrl);
    // Make the app role the owner, as in a default single-role deployment.
    await admin.query(`ALTER TABLE "audit_events" OWNER TO "idpn_app_test"`);
    await admin.end();

    const app = await connect(asRole('idpn_app_test'));
    try {
      const report = await checkAuditPrivileges(async (sql) => (await app.query(sql)).rows);
      expect(report.ok).toBe(false);
      expect(report.findings.join(' ')).toContain('owns audit_events');
      expect(report.findings.join(' ')).toContain('holds DELETE');
      expect(report.findings.join(' ')).toContain('holds TRUNCATE');
    } finally {
      await app.end();
    }
  });

  it('the owner could disable the trigger before the split (the gap being closed)', async () => {
    const app = await connect(asRole('idpn_app_test'));
    try {
      await app.query(`ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_append_only"`);
      await app.query(`ALTER TABLE "audit_events" ENABLE TRIGGER "audit_events_append_only"`);
    } finally {
      await app.end();
    }
  });

  it('moves ownership away and leaves the application with INSERT and SELECT only', async () => {
    const admin = await connect(adminUrl);
    try {
      for (const statement of buildAuditSplitStatements({
        appRole: 'idpn_app_test',
        ownerRole: 'idpn_audit_owner_test',
        maintenanceRole: 'idpn_maint_test',
      })) {
        await admin.query(statement);
      }
      // Applying twice changes nothing and does not fail.
      for (const statement of buildAuditSplitStatements({
        appRole: 'idpn_app_test',
        ownerRole: 'idpn_audit_owner_test',
        maintenanceRole: 'idpn_maint_test',
      })) {
        await admin.query(statement);
      }
    } finally {
      await admin.end();
    }

    const app = await connect(asRole('idpn_app_test'));
    try {
      const report = await checkAuditPrivileges(async (sql) => (await app.query(sql)).rows);
      expect(report).toMatchObject({ ok: true, tableOwner: 'idpn_audit_owner_test', findings: [] });

      await insertAudit(app);
      expect((await app.query(`SELECT count(*)::int AS n FROM "audit_events"`)).rows[0].n).toBe(1);

      await expect(app.query(`UPDATE "audit_events" SET "action" = 'x'`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query(`TRUNCATE "audit_events"`)).rejects.toThrow(/permission denied/);
      await expect(
        app.query(`ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_append_only"`),
      ).rejects.toThrow(/must be owner/);
      await expect(
        app.query(`DROP TRIGGER "audit_events_append_only" ON "audit_events"`),
      ).rejects.toThrow(/must be owner/);
    } finally {
      await app.end();
    }
  });

  it('the maintenance switch no longer helps the application role delete', async () => {
    const app = await connect(asRole('idpn_app_test'));
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('idpn.audit_maintenance', 'on', true)`);
      await expect(app.query(`DELETE FROM "audit_events"`)).rejects.toThrow(/permission denied/);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });

  it('still lets the maintenance role prune under the switch, and only then', async () => {
    const maintenance = await connect(asRole('idpn_maint_test'));
    try {
      await expect(maintenance.query(`DELETE FROM "audit_events"`)).rejects.toThrow(/append-only/);
      await maintenance.query('BEGIN');
      await maintenance.query(`SELECT set_config('idpn.audit_maintenance', 'on', true)`);
      const deleted = await maintenance.query(`DELETE FROM "audit_events"`);
      await maintenance.query('COMMIT');
      expect(deleted.rowCount).toBe(1);
    } finally {
      await maintenance.end();
    }
  });

  it('rejects unsafe role names instead of interpolating them', () => {
    expect(() =>
      buildAuditSplitStatements({ appRole: 'app"; DROP TABLE users; --', ownerRole: 'owner' }),
    ).toThrow(/lowercase PostgreSQL identifier/);
    expect(() => buildAuditSplitStatements({ appRole: 'same', ownerRole: 'same' })).toThrow(
      /must differ/,
    );
  });
});
