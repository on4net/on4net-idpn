import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Shared helpers for the operational backup/restore scripts (docs/monitoring.md).
 *
 * The scripts never print a connection URL or a password: every command failure is
 * sanitized before it reaches the log, and only file names, sizes and checksums are shown.
 * PostgreSQL tooling runs locally when `pg_dump`/`pg_restore`/`psql` are installed and
 * otherwise through the pinned `postgres:16-alpine` image, which is also what the local
 * compose file uses.
 */
export const POSTGRES_TOOL_IMAGE = 'postgres:16-alpine';
export const REDIS_TOOL_IMAGE = 'redis:7-alpine';
export const DEFAULT_RETENTION_DAYS = 14;

const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/** Removes credentials and secret key/value pairs from anything that may be logged. */
export function redactSecrets(message: string): string {
  return message
    .replace(/\/\/[^/@\s]+@/g, '//***@')
    .replace(/\b(password|passwd|secret|token|pwd)\s*=\s*[^\s&;]+/gi, '$1=***')
    .replace(/\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN))=([^\s]+)/g, '$1=***');
}

function commandLabel(file: string): string {
  return basename(file);
}

export function runCommand(
  file: string,
  args: readonly string[],
  options: CommandOptions = {},
): CommandResult {
  const spawnOptions: SpawnSyncOptions = {
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
    ...(options.input === undefined ? {} : { input: options.input }),
  };
  const result = spawnSync(file, [...args], spawnOptions);
  if (result.error !== undefined) {
    throw new Error(`failed to start ${commandLabel(file)}: ${result.error.message}`);
  }
  return {
    status: result.status ?? -1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

export function commandExists(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [command], { encoding: 'utf8', shell: false });
  return result.status === 0;
}

export function mustRun(
  file: string,
  args: readonly string[],
  label: string,
  options: CommandOptions = {},
): CommandResult {
  const result = runCommand(file, args, options);
  if (result.status !== 0) {
    const detail = redactSecrets(result.stderr.trim() || result.stdout.trim()).slice(0, 800);
    throw new Error(`${label} failed (exit ${result.status})${detail === '' ? '' : `: ${detail}`}`);
  }
  return result;
}

export interface DatabaseParts {
  url: string;
  database: string;
  maintenanceUrl: string;
}

/** Validates a PostgreSQL URL and derives the maintenance ("postgres") database URL. */
export function parseDatabaseUrl(raw: string): DatabaseParts {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('the database URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('the database URL must use postgres:// or postgresql://');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!DATABASE_NAME.test(database)) {
    throw new Error('the database URL must name a plain database (letters, digits, underscore)');
  }
  const maintenance = new URL(url.toString());
  maintenance.pathname = '/postgres';
  return { url: url.toString(), database, maintenanceUrl: maintenance.toString() };
}

export function scratchDatabaseUrl(raw: string, database: string): string {
  if (!DATABASE_NAME.test(database)) {
    throw new Error(`invalid scratch database name: ${database}`);
  }
  const url = new URL(raw);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Docker Desktop resolves the host as `host.docker.internal`; Linux needs --add-host. */
export function translateHostForContainer(raw: string): string {
  const url = new URL(raw);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') {
    url.hostname = 'host.docker.internal';
  }
  return url.toString();
}

export type PostgresAccess = { mode: 'local' } | { mode: 'docker'; image: string };

export function detectPostgresAccess(): PostgresAccess {
  const requested = process.env.OPS_PG_MODE;
  if (requested !== undefined && requested !== '' && requested !== 'auto') {
    if (requested === 'local') {
      if (commandExists('pg_dump') && commandExists('pg_restore') && commandExists('psql')) {
        return { mode: 'local' };
      }
      throw new Error('OPS_PG_MODE=local but pg_dump/pg_restore/psql are not installed');
    }
    if (requested === 'docker') {
      if (!commandExists('docker')) {
        throw new Error('OPS_PG_MODE=docker but docker is unavailable');
      }
      return { mode: 'docker', image: POSTGRES_TOOL_IMAGE };
    }
    throw new Error('OPS_PG_MODE must be auto, local or docker');
  }
  if (commandExists('pg_dump') && commandExists('pg_restore') && commandExists('psql')) {
    return { mode: 'local' };
  }
  if (commandExists('docker')) {
    return { mode: 'docker', image: POSTGRES_TOOL_IMAGE };
  }
  throw new Error(
    'pg_dump/pg_restore/psql are not installed and docker is unavailable; install PostgreSQL 16 client tools',
  );
}

function dockerRunArguments(
  access: Extract<PostgresAccess, { mode: 'docker' }>,
  mounts: readonly string[],
  withPassword: boolean,
): string[] {
  return [
    'run',
    '--rm',
    '--add-host=host.docker.internal:host-gateway',
    ...(withPassword ? ['--env', 'PGPASSWORD'] : []),
    ...mounts.flatMap((mount) => ['-v', mount]),
    access.image,
  ];
}

/**
 * Removes the password from a URL so it never appears in a process list. The caller passes
 * it to libpq through `PGPASSWORD` instead (Docker receives it via `--env PGPASSWORD`).
 */
export function stripUrlPassword(raw: string): { url: string; password?: string } {
  const url = new URL(raw);
  const password = url.password === '' ? undefined : decodeURIComponent(url.password);
  url.password = '';
  return password === undefined ? { url: url.toString() } : { url: url.toString(), password };
}

function toolEnvironment(password: string | undefined): CommandOptions {
  return password === undefined ? {} : { env: { ...process.env, PGPASSWORD: password } };
}

function absoluteDirectory(directory: string): string {
  return isAbsolute(directory) ? directory : resolve(directory);
}

export interface DumpDatabaseOptions {
  access: PostgresAccess;
  databaseUrl: string;
  outputDirectory: string;
  fileName: string;
}

/** Writes a custom-format dump; the caller handles checksums, encryption and retention. */
export function dumpDatabase(options: DumpDatabaseOptions): void {
  const directory = absoluteDirectory(options.outputDirectory);
  const credentials = stripUrlPassword(options.databaseUrl);
  const toolEnv = toolEnvironment(credentials.password);
  if (options.access.mode === 'docker') {
    mustRun(
      'docker',
      [
        ...dockerRunArguments(
          options.access,
          [`${directory}:/backup`],
          credentials.password !== undefined,
        ),
        'pg_dump',
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--file',
        `/backup/${options.fileName}`,
        translateHostForContainer(credentials.url),
      ],
      'pg_dump (container)',
      toolEnv,
    );
    return;
  }
  mustRun(
    'pg_dump',
    [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--file',
      join(directory, options.fileName),
      credentials.url,
    ],
    'pg_dump',
    toolEnv,
  );
}

export interface RestoreDatabaseOptions {
  access: PostgresAccess;
  databaseUrl: string;
  backupDirectory: string;
  fileName: string;
}

/** Restores a custom-format dump into an empty database; no implicit cleanup. */
export function restoreDatabase(options: RestoreDatabaseOptions): void {
  const directory = absoluteDirectory(options.backupDirectory);
  const credentials = stripUrlPassword(options.databaseUrl);
  const toolEnv = toolEnvironment(credentials.password);
  if (options.access.mode === 'docker') {
    mustRun(
      'docker',
      [
        ...dockerRunArguments(
          options.access,
          [`${directory}:/backup:ro`],
          credentials.password !== undefined,
        ),
        'pg_restore',
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
        '--single-transaction',
        '--dbname',
        translateHostForContainer(credentials.url),
        `/backup/${options.fileName}`,
      ],
      'pg_restore (container)',
      toolEnv,
    );
    return;
  }
  mustRun(
    'pg_restore',
    [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '--single-transaction',
      '--dbname',
      credentials.url,
      join(directory, options.fileName),
    ],
    'pg_restore',
    toolEnv,
  );
}

export interface SqlOptions {
  access: PostgresAccess;
  databaseUrl: string;
  sql: string;
}

/** Runs one SQL statement against `databaseUrl` (used for CREATE/DROP and verification). */
export function runSql(options: SqlOptions): string {
  const args = ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', options.sql];
  const credentials = stripUrlPassword(options.databaseUrl);
  const toolEnv = toolEnvironment(credentials.password);
  if (options.access.mode === 'docker') {
    const result = mustRun(
      'docker',
      [
        ...dockerRunArguments(options.access, [], credentials.password !== undefined),
        'psql',
        '--dbname',
        translateHostForContainer(credentials.url),
        ...args,
      ],
      'psql (container)',
      toolEnv,
    );
    return result.stdout.trim();
  }
  const result = mustRun('psql', ['--dbname', credentials.url, ...args], 'psql', toolEnv);
  return result.stdout.trim();
}

export function queryScalar(options: SqlOptions): number {
  const output = runSql(options).split('\n').at(-1)?.trim() ?? '';
  if (!/^\d+$/.test(output)) {
    throw new Error('verification query did not return a row count');
  }
  return Number.parseInt(output, 10);
}

/** Tables compared between the source and the restored database (FK-safe order not needed). */
export const VERIFIED_TABLES = [
  'users',
  'identities',
  'clients',
  'client_memberships',
  'roles',
  'permissions',
  'assignments',
  'sessions',
  'refresh_tokens',
  'authorization_codes',
  'audit_events',
] as const;

export interface BackupFileNames {
  timestamp: string;
  postgres: string;
  redis: string;
  manifest: string;
}

function utcStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function backupFileNames(now: Date, database: string): BackupFileNames {
  if (!DATABASE_NAME.test(database)) {
    throw new Error(`invalid database name for a backup file: ${database}`);
  }
  const timestamp = utcStamp(now);
  return {
    timestamp,
    postgres: `postgres-${database}-${timestamp}.dump`,
    redis: `redis-${database}-${timestamp}.rdb`,
    manifest: `manifest-${database}-${timestamp}.json`,
  };
}

/** Only files this tool wrote are eligible for retention; everything else is left alone. */
const BACKUP_ARTIFACT = /^(postgres|redis|manifest)-[A-Za-z0-9._-]+$/;

export interface RetentionEntry {
  name: string;
  mtimeMs: number;
}

export function selectExpiredFiles(entries: readonly RetentionEntry[], cutoffMs: number): string[] {
  return entries
    .filter((entry) => BACKUP_ARTIFACT.test(entry.name) && entry.mtimeMs < cutoffMs)
    .map((entry) => entry.name)
    .sort();
}

export async function listFiles(directory: string): Promise<RetentionEntry[]> {
  const names = await readdir(directory);
  const entries: RetentionEntry[] = [];
  for (const name of names) {
    try {
      const info = await stat(join(directory, name));
      if (info.isFile()) {
        entries.push({ name, mtimeMs: info.mtimeMs });
      }
    } catch {
      // A file removed between readdir and stat is simply not part of retention.
    }
  }
  return entries;
}

export async function applyRetention(
  directory: string,
  retentionDays: number,
  now: Date,
  protectedNames: readonly string[] = [],
): Promise<string[]> {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error('retention days must be zero or a positive number');
  }
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const expired = selectExpiredFiles(await listFiles(directory), cutoffMs).filter(
    (name) => !protectedNames.includes(name),
  );
  for (const name of expired) {
    await unlink(join(directory, name));
  }
  return expired;
}

export async function sha256File(file: string): Promise<string> {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

export async function writeChecksum(file: string): Promise<string> {
  const checksum = await sha256File(file);
  await writeFile(`${file}.sha256`, `${checksum}  ${basename(file)}\n`, 'utf8');
  return checksum;
}

export interface ChecksumVerification {
  verified: boolean;
  expected: string;
  actual: string;
}

/** Reads `<file>.sha256` (`<hex>  <name>`) and hashes the file again. */
export async function verifyChecksum(
  file: string,
  checksumFile = `${file}.sha256`,
): Promise<ChecksumVerification> {
  let content: string;
  try {
    content = await readFile(checksumFile, 'utf8');
  } catch {
    throw new Error(`checksum file not found: ${basename(checksumFile)}`);
  }
  const expected = content.trim().split(/\s+/)[0] ?? '';
  if (!/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error(`checksum file ${basename(checksumFile)} is malformed`);
  }
  const actual = await sha256File(file);
  return { verified: expected.toLowerCase() === actual, expected, actual };
}

/** Writes atomically so a reader never sees a half-written status/manifest file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

/** Optional AES-256 encryption at rest through `age`; fails closed when it is missing. */
export function encryptWithAge(file: string, recipient: string): string {
  if (!commandExists('age')) {
    throw new Error(
      'age is not installed; install age or store the backup on an encrypted volume (docs/monitoring.md)',
    );
  }
  const encrypted = `${file}.age`;
  mustRun('age', ['-r', recipient, '-o', encrypted, file], 'age encryption');
  return encrypted;
}

export interface RedisSnapshotOptions {
  redisUrl: string;
  outputFile: string;
  /** Docker container name when `redis-cli` is not installed. */
  container?: string;
  waitTimeoutMs?: number;
}

function redisCliPrefix(container: string | undefined, withAuth: boolean): string[] {
  if (container === undefined) {
    return [];
  }
  return ['exec', ...(withAuth ? ['--env', 'REDISCLI_AUTH'] : []), container];
}

/** Produces a consistent RDB snapshot through `redis-cli --rdb` or a container BGSAVE+copy. */
export async function snapshotRedis(options: RedisSnapshotOptions): Promise<void> {
  await mkdir(dirname(options.outputFile), { recursive: true });
  const temporary = `${options.outputFile}.partial`;
  const credentials = stripUrlPassword(options.redisUrl);
  const auth = credentials.password ?? process.env.REDISCLI_AUTH;
  const redisEnv: CommandOptions =
    auth === undefined ? {} : { env: { ...process.env, REDISCLI_AUTH: auth } };

  if (commandExists('redis-cli')) {
    mustRun('redis-cli', ['-u', credentials.url, '--rdb', temporary], 'redis-cli --rdb', redisEnv);
    await rename(temporary, options.outputFile);
    return;
  }

  if (!commandExists('docker')) {
    throw new Error('redis-cli is not installed and docker is unavailable; cannot snapshot Redis');
  }
  const host = new URL(credentials.url).hostname;
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const configuredContainer = options.container ?? process.env.REDIS_CONTAINER;
  if (configuredContainer === undefined && !loopback) {
    throw new Error(
      'redis-cli is required to snapshot a remote Redis; install it or pass --redis-container for a local container',
    );
  }
  const container = configuredContainer ?? 'idpn-redis';
  const prefix = redisCliPrefix(container, auth !== undefined);
  mustRun('docker', [...prefix, 'redis-cli', 'BGSAVE'], 'redis BGSAVE', redisEnv);

  const deadline = Date.now() + (options.waitTimeoutMs ?? 120_000);
  let lastInfo = '';
  while (Date.now() < deadline) {
    const info = mustRun(
      'docker',
      [...prefix, 'redis-cli', 'INFO', 'persistence'],
      'redis INFO persistence',
      redisEnv,
    ).stdout;
    lastInfo = info;
    if (/rdb_bgsave_in_progress:0/.test(info) && !/rdb_last_bgsave_status:err/.test(info)) {
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (!/rdb_bgsave_in_progress:0/.test(lastInfo)) {
    throw new Error('Redis BGSAVE did not finish before the timeout');
  }
  if (/rdb_last_bgsave_status:err/.test(lastInfo)) {
    throw new Error('Redis reported a failed BGSAVE');
  }
  mustRun('docker', ['cp', `${container}:/data/dump.rdb`, temporary], 'copy Redis dump.rdb');
  await rename(temporary, options.outputFile);
}

/** Validates the RDB header/checksum with `redis-check-rdb` (container or local binary). */
export function verifyRedisDump(file: string): void {
  const directory = absoluteDirectory(dirname(file));
  const name = basename(file);
  if (commandExists('redis-check-rdb')) {
    mustRun('redis-check-rdb', [file], 'redis-check-rdb');
    return;
  }
  if (!commandExists('docker')) {
    throw new Error('redis-check-rdb is not installed and docker is unavailable');
  }
  mustRun(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${directory}:/backup:ro`,
      REDIS_TOOL_IMAGE,
      'redis-check-rdb',
      `/backup/${name}`,
    ],
    'redis-check-rdb (container)',
  );
}

/** Best-effort cleanup helper used by the drill and tests. */
export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index] ?? 'TiB'}`;
}
