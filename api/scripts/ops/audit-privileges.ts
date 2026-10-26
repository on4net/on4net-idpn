import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { flagValue, hasFlag, parseArgs } from '../cli-args.js';

/**
 * Audit-log privilege split (card #77 section 4, docs/security.md 10).
 *
 * The append-only trigger on `audit_events` is only as strong as the role that can change it:
 * while the application role owns the table it can `DISABLE TRIGGER`, `DROP TRIGGER` or run the
 * maintenance switch itself. The split moves ownership to a NOLOGIN role and leaves the
 * application with `INSERT, SELECT` only:
 *
 *   - `owner`: NOLOGIN, owns `audit_events` and its trigger function;
 *   - `app`: the role the API connects as, `INSERT` and `SELECT` on the table;
 *   - `maintenance` (optional): a login role that is a member of `owner`, used only by
 *     `ops:audit-retention` (DELETE under the `idpn.audit_maintenance` switch).
 *
 * `print` writes the SQL for a DBA, `apply` runs it with an administrative connection, and
 * `check` (run with the APPLICATION's `DATABASE_URL`) verifies the result from the application's
 * point of view and fails when the app role could still weaken the log.
 */

export interface AuditSplitRoles {
  /** Role the API connects as. */
  appRole: string;
  /** NOLOGIN owner of the audit table (created when missing). */
  ownerRole: string;
  /** Optional login role granted membership of the owner for retention runs. */
  maintenanceRole?: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function identifier(name: string, label: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`${label} must be a lowercase PostgreSQL identifier`);
  }
  return `"${name}"`;
}

const literal = (name: string): string => `'${name.replace(/'/g, "''")}'`;

/** The statements, in order. Every name is validated and quoted; nothing is interpolated raw. */
export function buildAuditSplitStatements(roles: AuditSplitRoles): string[] {
  const app = identifier(roles.appRole, 'app role');
  const owner = identifier(roles.ownerRole, 'owner role');
  if (roles.appRole === roles.ownerRole) {
    throw new Error('the owner role must differ from the application role');
  }
  const statements = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(roles.ownerRole)}) ` +
      `THEN CREATE ROLE ${owner} NOLOGIN; END IF; END $$`,
    `ALTER TABLE "audit_events" OWNER TO ${owner}`,
    `ALTER FUNCTION "audit_events_append_only"() OWNER TO ${owner}`,
    `REVOKE ALL ON TABLE "audit_events" FROM PUBLIC`,
    `REVOKE ALL ON TABLE "audit_events" FROM ${app}`,
    `GRANT INSERT, SELECT ON TABLE "audit_events" TO ${app}`,
    // A role that can create roles could grant itself membership of the owner.
    `ALTER ROLE ${app} NOCREATEROLE`,
  ];
  if (roles.maintenanceRole !== undefined) {
    statements.push(`GRANT ${owner} TO ${identifier(roles.maintenanceRole, 'maintenance role')}`);
  }
  return statements;
}

export interface PrivilegeQuery {
  (sql: string): Promise<Record<string, unknown>[]>;
}

export interface AuditPrivilegeReport {
  ok: boolean;
  currentUser: string;
  tableOwner: string | null;
  findings: string[];
}

/**
 * Looks at `audit_events` from the point of view of the connected role. A superuser always
 * bypasses privileges, so running the check as one is itself a finding.
 */
export async function checkAuditPrivileges(query: PrivilegeQuery): Promise<AuditPrivilegeReport> {
  const [info] = await query(
    `SELECT current_user AS current_user,
            pg_get_userbyid(c.relowner) AS owner,
            r.rolsuper AS superuser,
            r.rolcreaterole AS createrole,
            pg_has_role(current_user, c.relowner, 'MEMBER') AS owner_member,
            has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
            has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete,
            has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate,
            has_table_privilege(current_user, c.oid, 'TRIGGER') AS can_trigger,
            has_table_privilege(current_user, c.oid, 'REFERENCES') AS can_references,
            has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
            (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
               WHERE p.proname = 'audit_events_append_only' AND p.pronamespace = c.relnamespace) AS function_owner,
            (SELECT pg_has_role(current_user, p.proowner, 'MEMBER') FROM pg_proc p
               WHERE p.proname = 'audit_events_append_only' AND p.pronamespace = c.relnamespace) AS function_owner_member,
            pg_get_userbyid(n.nspowner) AS schema_owner,
            pg_has_role(current_user, n.nspowner, 'MEMBER') AS schema_owner_member,
            (SELECT count(*) FROM pg_trigger tg
               WHERE tg.tgrelid = c.oid AND tg.tgname IN ('audit_events_append_only', 'audit_events_no_truncate')
                 AND tg.tgenabled = 'O') AS enabled_triggers
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.rolname = current_user
      WHERE c.relname = 'audit_events' AND c.relnamespace = 'public'::regnamespace`,
  );
  if (info === undefined) {
    return {
      ok: false,
      currentUser: '',
      tableOwner: null,
      findings: ['audit_events does not exist in the public schema'],
    };
  }
  const findings: string[] = [];
  const owner = String(info['owner']);
  const user = String(info['current_user']);
  if (info['superuser'] === true) {
    findings.push(`${user} is a superuser: it bypasses every privilege on audit_events`);
  }
  if (info['createrole'] === true) {
    findings.push(`${user} has CREATEROLE and could grant itself membership of the owner role`);
  }
  if (owner === user) {
    findings.push(`${user} owns audit_events and can disable or drop its append-only trigger`);
  } else if (info['owner_member'] === true) {
    findings.push(`${user} is a member of ${owner}, the owner of audit_events`);
  }
  const functionOwner = info['function_owner'];
  if (functionOwner === null || functionOwner === undefined) {
    findings.push('the audit_events_append_only() trigger function is missing');
  } else if (functionOwner === user || info['function_owner_member'] === true) {
    findings.push(
      `${user} owns (or is a member of the owner of) audit_events_append_only() and could replace the trigger logic`,
    );
  }
  const schemaOwner = String(info['schema_owner']);
  if (schemaOwner === user || info['schema_owner_member'] === true) {
    findings.push(
      `${user} owns the public schema (${schemaOwner}) and could drop or recreate audit_events; ` +
        'run migrations and the API as different roles and do not make the API role the database owner',
    );
  }
  if (Number(info['enabled_triggers']) !== 2) {
    findings.push('the append-only triggers on audit_events are missing or disabled');
  }
  for (const [privilege, key] of [
    ['UPDATE', 'can_update'],
    ['DELETE', 'can_delete'],
    ['TRUNCATE', 'can_truncate'],
    ['TRIGGER', 'can_trigger'],
    ['REFERENCES', 'can_references'],
  ] as const) {
    if (info[key] === true) {
      findings.push(`${user} holds ${privilege} on audit_events`);
    }
  }
  if (info['can_insert'] !== true) {
    findings.push(`${user} cannot INSERT into audit_events: the API could not write audit rows`);
  }
  return { ok: findings.length === 0, currentUser: user, tableOwner: owner, findings };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.command;
  const roles: AuditSplitRoles = {
    appRole: flagValue(args, 'app-role') ?? 'idpn_app',
    ownerRole: flagValue(args, 'owner-role') ?? 'idpn_audit_owner',
    ...(flagValue(args, 'maintenance-role') === undefined
      ? {}
      : { maintenanceRole: flagValue(args, 'maintenance-role') as string }),
  };

  if (command === 'print') {
    console.log(`${buildAuditSplitStatements(roles).join(';\n')};`);
    return;
  }

  if (command === 'apply') {
    const adminUrl = flagValue(args, 'admin-url');
    if (adminUrl === undefined) {
      throw new Error('--admin-url (a role that may ALTER the table owner) is required');
    }
    if (!hasFlag(args, 'confirm')) {
      throw new Error('apply changes table ownership and privileges; pass --confirm');
    }
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      for (const statement of buildAuditSplitStatements(roles)) {
        await client.query(statement);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
    console.log(`audit privilege split applied (owner ${roles.ownerRole}, app ${roles.appRole})`);
    return;
  }

  if (command === 'check') {
    const url = flagValue(args, 'database-url') ?? process.env['DATABASE_URL'];
    if (url === undefined || url === '') {
      throw new Error('DATABASE_URL (the application role) is required');
    }
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const report = await checkAuditPrivileges(async (sql) => (await client.query(sql)).rows);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } finally {
      await client.end();
    }
    return;
  }

  throw new Error(
    'usage: audit-privileges.ts <print|apply|check> [--app-role R] [--owner-role R] ' +
      '[--maintenance-role R] [--admin-url URL --confirm] [--database-url URL]',
  );
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(resolve(entrypoint)).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
