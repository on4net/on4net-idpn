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

export interface RollbackOptions {
  connectionString: string;
  migrationsDir?: string;
}

/**
 * Rolls back the most recently applied Prisma migration by running its `down.sql`
 * and removing its bookkeeping row, in a single transaction.
 *
 * @returns the rolled back migration name, or `null` when nothing is applied.
 */
export async function rollbackLatestMigration(options: RollbackOptions): Promise<string | null> {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const client = new Client({ connectionString: options.connectionString });
  await client.connect();

  try {
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
      await client.query('DELETE FROM "_prisma_migrations" WHERE "migration_name" = $1', [
        latest.migration_name,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    return latest.migration_name;
  } finally {
    await client.end();
  }
}
