import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

const DEFAULT_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'prisma',
  'migrations',
);

/**
 * Advisory-lock key shared by every rollback run against the same database.
 * `pg_advisory_lock` is session-scoped, so a crashed run releases it when the
 * connection drops instead of leaving the schema half-applied.
 */
const ROLLBACK_LOCK_KEY = 'idpn:prisma:rollback';

export interface RollbackOptions {
  connectionString: string;
  migrationsDir?: string;
  /**
   * Explicit opt-in. Rolling back executes the migration's `down.sql`, which may drop
   * tables, so a call without confirmation is refused before any connection is opened.
   * The CLI maps this to `--yes`.
   */
  confirm?: boolean;
}

/**
 * Rolls back the most recently applied Prisma migration by running its `down.sql` and
 * marking its bookkeeping row as rolled back, in a single transaction.
 *
 * The row is kept and `rolled_back_at` is set — the same semantics as
 * `prisma migrate resolve --rolled-back` — so `prisma migrate deploy` re-applies the
 * migration afterwards and the history of what was applied and reverted stays auditable.
 *
 * @returns the rolled back migration name, or `null` when nothing is applied.
 */
export async function rollbackLatestMigration(options: RollbackOptions): Promise<string | null> {
  if (options.confirm !== true) {
    throw new Error(
      'Refusing to roll back without explicit confirmation: the down migration can drop tables. ' +
        'Pass `confirm: true` (CLI: `db:rollback --yes`).',
    );
  }

  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const client = new Client({ connectionString: options.connectionString });
  await client.connect();

  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [ROLLBACK_LOCK_KEY]);
    locked = true;

    const { rows } = await client.query<{ migration_name: string }>(
      `SELECT "migration_name"
         FROM "_prisma_migrations"
        WHERE "finished_at" IS NOT NULL
          AND "rolled_back_at" IS NULL
        ORDER BY "started_at" DESC, "migration_name" DESC
        LIMIT 1`,
    );
    const latest = rows[0];
    if (latest === undefined) {
      return null;
    }

    const downPath = resolve(migrationsDir, latest.migration_name, 'down.sql');
    let sql: string;
    try {
      sql = await readFile(downPath, 'utf8');
    } catch {
      throw new Error(`Missing down migration for ${latest.migration_name}: ${downPath}`);
    }

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        `UPDATE "_prisma_migrations"
            SET "rolled_back_at" = now()
          WHERE "migration_name" = $1
            AND "rolled_back_at" IS NULL`,
        [latest.migration_name],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    return latest.migration_name;
  } finally {
    if (locked) {
      // Best effort: the lock dies with the session anyway if this connection is broken.
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [ROLLBACK_LOCK_KEY])
        .catch(() => undefined);
    }
    await client.end();
  }
}
