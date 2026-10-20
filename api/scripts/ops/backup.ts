import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  applyRetention,
  backupFileNames,
  DEFAULT_RETENTION_DAYS,
  detectPostgresAccess,
  dumpDatabase,
  encryptWithAge,
  formatBytes,
  parseDatabaseUrl,
  snapshotRedis,
  verifyRedisDump,
  writeChecksum,
  writeJsonAtomic,
  type PostgresAccess,
} from './ops-lib.js';

/**
 * Encrypted-at-rest backup of PostgreSQL and Redis (docs/monitoring.md).
 *
 *   pnpm --filter @idpn/api run ops:backup
 *   pnpm --filter @idpn/api run ops:backup -- --retention-days 30 --age-recipient age1...
 *
 * The PostgreSQL dump is logical (custom format). A logical dump alone gives an RPO equal to
 * its schedule; production enables WAL archiving (pgBackRest/WAL-G) for the documented
 * 15-minute RPO. Redis holds sessions and rate-limit counters only: losing it forces users
 * to sign in again but does not lose identities, clients or audit events.
 */
export interface BackupOptions {
  databaseUrl: string;
  outputDirectory: string;
  redisUrl?: string;
  redisContainer?: string;
  retentionDays?: number;
  ageRecipient?: string;
  /** Defaults to `<outputDirectory>/status.json`, read by the API freshness gauge. */
  statusFile?: string;
  now?: Date;
  log?: (line: string) => void;
  access?: PostgresAccess;
}

export interface BackupFileRecord {
  name: string;
  bytes: number;
  sha256: string;
  encrypted: boolean;
}

export interface BackupResult {
  createdAt: string;
  database: string;
  outputDirectory: string;
  targets: string[];
  files: BackupFileRecord[];
  expired: string[];
  statusFile: string;
}

async function finishArtifact(
  file: string,
  recipient: string | undefined,
): Promise<{ file: string; record: Omit<BackupFileRecord, 'bytes'> }> {
  let finalFile = file;
  let encrypted = false;
  if (recipient !== undefined) {
    finalFile = encryptWithAge(file, recipient);
    await unlink(file);
    await unlink(`${file}.sha256`).catch(() => undefined);
    encrypted = true;
  }
  const sha256 = await writeChecksum(finalFile);
  return { file: finalFile, record: { name: finalFile, sha256, encrypted } };
}

export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? new Date();
  const database = parseDatabaseUrl(options.databaseUrl);
  const access = options.access ?? detectPostgresAccess();
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const outputDirectory = resolve(options.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });

  const names = backupFileNames(now, database.database);
  const files: BackupFileRecord[] = [];
  const written: string[] = [];

  // --- PostgreSQL ---------------------------------------------------------
  const dumpPath = join(outputDirectory, names.postgres);
  const partialDump = `${dumpPath}.partial`;
  dumpDatabase({
    access,
    databaseUrl: database.url,
    outputDirectory,
    fileName: `${names.postgres}.partial`,
  });
  await rename(partialDump, dumpPath);
  const dumpArtifact = await finishArtifact(dumpPath, options.ageRecipient);
  files.push({
    ...dumpArtifact.record,
    bytes: (await stat(dumpArtifact.file)).size,
  });
  written.push(dumpArtifact.file, `${dumpArtifact.file}.sha256`);

  // --- Redis (sessions, rate limits, queue; not the source of truth) ------
  const targets = ['postgres'];
  if (options.redisUrl !== undefined && options.redisUrl.trim() !== '') {
    const redisPath = join(outputDirectory, names.redis);
    await snapshotRedis({
      redisUrl: options.redisUrl,
      outputFile: redisPath,
      ...(options.redisContainer === undefined ? {} : { container: options.redisContainer }),
    });
    verifyRedisDump(redisPath);
    const redisArtifact = await finishArtifact(redisPath, options.ageRecipient);
    files.push({
      ...redisArtifact.record,
      bytes: (await stat(redisArtifact.file)).size,
    });
    written.push(redisArtifact.file, `${redisArtifact.file}.sha256`);
    targets.push('redis');
  } else {
    log('redis: skipped (no --redis-url / REDIS_URL)');
  }

  // --- Manifest, retention, freshness status ------------------------------
  const manifestPath = join(outputDirectory, names.manifest);
  const createdAt = now.toISOString();
  const manifest = {
    schemaVersion: 1,
    createdAt,
    database: database.database,
    targets,
    retentionDays,
    encryption: options.ageRecipient === undefined ? 'none' : 'age',
    files: files.map((file) => ({
      name: file.name.slice(outputDirectory.length + 1),
      bytes: file.bytes,
      sha256: file.sha256,
      encrypted: file.encrypted,
    })),
  };
  await writeJsonAtomic(manifestPath, manifest);
  const manifestSha = await writeChecksum(manifestPath);
  written.push(manifestPath, `${manifestPath}.sha256`);

  const expired = await applyRetention(outputDirectory, retentionDays, now, written);

  const statusFile = resolve(options.statusFile ?? join(outputDirectory, 'status.json'));
  await writeJsonAtomic(statusFile, {
    lastSuccessAt: createdAt,
    targets,
    postgresBytes: files[0]?.bytes ?? 0,
    ...(files[1] === undefined ? {} : { redisBytes: files[1].bytes }),
  });

  log(`backup: ${results(files, createdAt)}`);
  log(`manifest: ${manifestPath} (sha256 ${manifestSha})`);
  if (expired.length > 0) {
    log(`retention: removed ${expired.length} file(s) older than ${retentionDays} day(s)`);
  }
  log(`status: ${statusFile}`);

  return {
    createdAt,
    database: database.database,
    outputDirectory,
    targets,
    files,
    expired,
    statusFile,
  };
}

function results(files: readonly BackupFileRecord[], createdAt: string): string {
  return [
    `created ${createdAt}`,
    ...files.map(
      (file) => `${file.name} (${formatBytes(file.bytes)}, sha256 ${file.sha256.slice(0, 12)}…)`,
    ),
  ].join('; ');
}

function parseArguments(argv: readonly string[]): { options: BackupOptions; help: boolean } {
  const values = new Map<string, string>();
  let help = false;
  let noRedis = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--no-redis') {
      noRedis = true;
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

  const databaseUrl = values.get('database-url') ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL or --database-url is required');
  }
  const outputDirectory = values.get('output-dir') ?? process.env.BACKUP_OUTPUT_DIR ?? 'backups';
  const redisUrl = noRedis ? undefined : (values.get('redis-url') ?? process.env.REDIS_URL);
  const retentionRaw = values.get('retention-days');
  return {
    help,
    options: {
      databaseUrl,
      outputDirectory,
      ...(redisUrl === undefined || redisUrl.trim() === '' ? {} : { redisUrl }),
      ...(values.get('redis-container') === undefined
        ? {}
        : { redisContainer: values.get('redis-container') }),
      ...(retentionRaw === undefined ? {} : { retentionDays: Number(retentionRaw) }),
      ...(values.get('age-recipient') === undefined
        ? {}
        : { ageRecipient: values.get('age-recipient') }),
      ...(values.get('status-file') === undefined ? {} : { statusFile: values.get('status-file') }),
    },
  };
}

const HELP = `Usage: tsx scripts/ops/backup.ts [options]

  --database-url URL     PostgreSQL URL (default: DATABASE_URL)
  --redis-url URL        Redis URL for an RDB snapshot (default: REDIS_URL)
  --redis-container NAME Docker container used when redis-cli is absent (default: idpn-redis)
  --no-redis             Skip the Redis snapshot
  --output-dir DIR       Destination directory (default: BACKUP_OUTPUT_DIR or ./backups)
  --retention-days N     Delete our own artifacts older than N days (default: ${DEFAULT_RETENTION_DAYS})
  --age-recipient RCPT   Encrypt each artifact with age (age must be installed)
  --status-file FILE     Freshness JSON read by the API (default: <output-dir>/status.json)
`;

async function main(): Promise<void> {
  const { options, help } = parseArguments(process.argv.slice(2));
  if (help) {
    console.log(HELP);
    return;
  }
  const result = await runBackup(options);
  console.log(`backup complete: ${result.files.length} artifact(s)`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(resolve(entrypoint)).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
