import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  commandExists,
  detectPostgresAccess,
  mustRun,
  parseDatabaseUrl,
  queryScalar,
  restoreDatabase,
  runSql,
  scratchDatabaseUrl,
  verifyChecksum,
  verifyRedisDump,
  VERIFIED_TABLES,
  type PostgresAccess,
} from './ops-lib.js';

/**
 * Verified restore of a PostgreSQL backup (docs/monitoring.md).
 *
 * `--drill` creates a scratch database on the source server, restores the dump into it,
 * compares row counts with the source, measures the restore time (the RTO evidence) and
 * drops the scratch database again. A plain restore into an existing target requires
 * `--allow-non-scratch` unless the database name clearly marks it as a scratch/restore DB.
 */
export interface RestoreOptions {
  backupFile: string;
  /** Existing target for a real restore. Ignored in drill mode. */
  targetUrl?: string;
  /** Source server used to create the scratch database and compare row counts. */
  sourceUrl?: string;
  drill?: boolean;
  keep?: boolean;
  allowNonScratch?: boolean;
  ageIdentity?: string;
  skipChecksum?: boolean;
  access?: PostgresAccess;
  now?: Date;
  log?: (line: string) => void;
}

export interface RestoreCount {
  source: number | null;
  target: number;
}

export interface RestoreResult {
  restored: boolean;
  targetDatabase: string;
  scratchDatabase: string | null;
  durationSeconds: number;
  rtoSeconds: number;
  checksumVerified: boolean;
  counts: Record<string, RestoreCount>;
}

const SCRATCH_NAME = /^[a-z][a-z0-9_]{0,62}$/;

function assertScratchName(name: string): void {
  if (!SCRATCH_NAME.test(name)) {
    throw new Error('scratch database names must be lowercase letters, digits or underscore');
  }
}

function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').toLowerCase();
}

async function decryptIfNeeded(
  file: string,
  identity: string | undefined,
): Promise<{ file: string; cleanup: string | null }> {
  if (!file.toLowerCase().endsWith('.age')) {
    return { file, cleanup: null };
  }
  if (identity === undefined || identity.trim() === '') {
    throw new Error('an encrypted backup needs --age-identity');
  }
  if (!commandExists('age')) {
    throw new Error('age is not installed; cannot decrypt the backup');
  }
  const plain = join(tmpdir(), `${basename(file, '.age')}.${process.pid}.restore`);
  mustRun('age', ['-d', '-i', identity, '-o', plain, file], 'age decryption');
  return { file: plain, cleanup: plain };
}

function restoreTargetGuard(targetDatabase: string, sourceDatabase: string | null): void {
  const scratchish = /(restore|drill|scratch|test)/i.test(targetDatabase);
  if (sourceDatabase !== null && targetDatabase === sourceDatabase) {
    throw new Error('refusing to restore a database over itself; use --drill or a new database');
  }
  if (!scratchish) {
    throw new Error(
      `refusing to restore into "${targetDatabase}"; pass --allow-non-scratch for a real disaster recovery`,
    );
  }
}

export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const startedAt = performance.now();
  const now = options.now ?? new Date();
  const access = options.access ?? detectPostgresAccess();
  const backupFile = resolve(options.backupFile);

  if (!existsSync(backupFile)) {
    throw new Error(`backup file not found: ${basename(backupFile)}`);
  }

  const checksum = options.skipChecksum === true ? null : await verifyChecksum(backupFile);
  if (checksum !== null && !checksum.verified) {
    throw new Error(
      `checksum mismatch for ${basename(backupFile)} (expected ${checksum.expected.slice(0, 12)}…, got ${checksum.actual.slice(0, 12)}…)`,
    );
  }
  log(
    checksum === null
      ? `checksum: skipped for ${basename(backupFile)}`
      : `checksum: verified sha256 ${checksum.actual.slice(0, 12)}…`,
  );

  const decrypted = await decryptIfNeeded(backupFile, options.ageIdentity);
  let scratchDatabase: string | null = null;
  let targetUrl: string;
  let sourceDatabase: string | null;

  try {
    const restoreDirectory = dirname(decrypted.file);
    const restoreFileName = basename(decrypted.file);

    if (options.drill === true) {
      if (options.sourceUrl === undefined || options.sourceUrl.trim() === '') {
        throw new Error('--drill requires --source-url (or DATABASE_URL)');
      }
      const source = parseDatabaseUrl(options.sourceUrl);
      sourceDatabase = source.database;
      scratchDatabase = `idpn_restore_drill_${utcStamp(now)}`.slice(0, 63);
      assertScratchName(scratchDatabase);
      targetUrl = scratchDatabaseUrl(source.url, scratchDatabase);

      log(`drill: creating scratch database ${scratchDatabase}`);
      runSql({
        access,
        databaseUrl: source.maintenanceUrl,
        sql: `DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`,
      });
      runSql({
        access,
        databaseUrl: source.maintenanceUrl,
        sql: `CREATE DATABASE "${scratchDatabase}"`,
      });

      restoreDatabase({
        access,
        databaseUrl: targetUrl,
        backupDirectory: restoreDirectory,
        fileName: restoreFileName,
      });
    } else {
      if (options.targetUrl === undefined || options.targetUrl.trim() === '') {
        throw new Error('--target-url is required unless --drill is used');
      }
      const target = parseDatabaseUrl(options.targetUrl);
      const source = options.sourceUrl === undefined ? null : parseDatabaseUrl(options.sourceUrl);
      sourceDatabase = source?.database ?? null;
      if (options.allowNonScratch !== true) {
        restoreTargetGuard(target.database, sourceDatabase);
      }
      targetUrl = target.url;
      restoreDatabase({
        access,
        databaseUrl: targetUrl,
        backupDirectory: restoreDirectory,
        fileName: restoreFileName,
      });
    }

    const targetDatabase = parseDatabaseUrl(targetUrl).database;
    const counts: Record<string, RestoreCount> = {};
    for (const table of VERIFIED_TABLES) {
      const targetCount = queryScalar({
        access,
        databaseUrl: targetUrl,
        sql: `SELECT count(*) FROM "${table}"`,
      });
      const sourceCount =
        sourceDatabase === null || options.sourceUrl === undefined
          ? null
          : queryScalar({
              access,
              databaseUrl: options.sourceUrl,
              sql: `SELECT count(*) FROM "${table}"`,
            });
      if (sourceCount !== null && sourceCount !== targetCount) {
        throw new Error(
          `restore verification failed for ${table}: source ${sourceCount}, target ${targetCount}`,
        );
      }
      counts[table] = { source: sourceCount, target: targetCount };
    }

    const rtoSeconds = Math.max(0, (performance.now() - startedAt) / 1000);
    log(
      `restore: verified ${VERIFIED_TABLES.length} tables in ${targetDatabase} (RTO ${rtoSeconds.toFixed(2)}s)`,
    );

    return {
      restored: true,
      targetDatabase,
      scratchDatabase,
      durationSeconds: rtoSeconds,
      rtoSeconds,
      checksumVerified: checksum !== null && checksum.verified,
      counts,
    };
  } finally {
    if (decrypted.cleanup !== null) {
      await rm(decrypted.cleanup, { force: true });
    }
    if (scratchDatabase !== null && options.keep !== true) {
      const source = options.sourceUrl === undefined ? null : parseDatabaseUrl(options.sourceUrl);
      if (source !== null) {
        try {
          runSql({
            access,
            databaseUrl: source.maintenanceUrl,
            sql: `DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`,
          });
          log(`drill: dropped scratch database ${scratchDatabase}`);
        } catch (error) {
          log(
            `drill: scratch database ${scratchDatabase} could not be dropped: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }
}

interface ParsedArguments {
  options: RestoreOptions;
  help: boolean;
  json: boolean;
  redisBackup?: string;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      flags.add('help');
      continue;
    }
    if (
      argument === '--drill' ||
      argument === '--keep' ||
      argument === '--allow-non-scratch' ||
      argument === '--skip-checksum' ||
      argument === '--json'
    ) {
      flags.add(argument.slice(2));
      continue;
    }
    if (argument === undefined || !argument.startsWith('--')) {
      throw new Error(`unexpected argument: ${argument ?? ''}`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`${argument} requires a value`);
    }
    values.set(argument.slice(2), value);
    index += 1;
  }

  const backupFile = values.get('backup');
  if (backupFile === undefined) {
    throw new Error('--backup is required');
  }
  const sourceUrl = values.get('source-url') ?? process.env.DATABASE_URL;
  return {
    help: flags.has('help'),
    json: flags.has('json'),
    ...(values.get('redis-backup') === undefined
      ? {}
      : { redisBackup: values.get('redis-backup') }),
    options: {
      backupFile,
      ...(values.get('target-url') === undefined ? {} : { targetUrl: values.get('target-url') }),
      ...(sourceUrl === undefined || sourceUrl.trim() === '' ? {} : { sourceUrl }),
      ...(flags.has('drill') ? { drill: true } : {}),
      ...(flags.has('keep') ? { keep: true } : {}),
      ...(flags.has('allow-non-scratch') ? { allowNonScratch: true } : {}),
      ...(values.get('age-identity') === undefined
        ? {}
        : { ageIdentity: values.get('age-identity') }),
      ...(flags.has('skip-checksum') ? { skipChecksum: true } : {}),
    },
  };
}

const HELP = `Usage: tsx scripts/ops/restore.ts --backup FILE [options]

  --backup FILE          Custom-format dump produced by ops:backup (required)
  --drill                Restore into a scratch DB on --source-url, verify, then drop
  --source-url URL       Source PostgreSQL URL for the drill comparison (default: DATABASE_URL)
  --target-url URL       Target database for a real restore (required without --drill)
  --keep                 Keep the drill scratch database for inspection
  --allow-non-scratch    Allow restoring into a production-looking database (disaster recovery)
  --age-identity FILE    age identity used to decrypt a .age backup
  --skip-checksum        Do not require the .sha256 sidecar (not recommended)
  --redis-backup FILE    Also validate an RDB snapshot and print restore instructions
  --json                 Print the result as JSON
`;

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log(HELP);
    return;
  }
  if (parsed.redisBackup !== undefined) {
    verifyRedisDump(resolve(parsed.redisBackup));
    console.log(
      `redis: ${basename(parsed.redisBackup)} is a valid RDB. To restore: stop Redis, replace its ` +
        'dump.rdb with this file (same Redis major version), then start Redis; confirm with ' +
        '`redis-check-rdb` and `DBSIZE` (docs/monitoring.md).',
    );
  }
  const result = await runRestore(parsed.options);
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(resolve(entrypoint)).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
