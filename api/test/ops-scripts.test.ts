import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasFlag, parseArgs } from '../scripts/cli-args.js';
import { parseArguments as parseBackupArguments } from '../scripts/ops/backup.js';
import {
  backupFileNames,
  detectPostgresAccess,
  formatBytes,
  parseDatabaseUrl,
  redactSecrets,
  scratchDatabaseUrl,
  selectExpiredFiles,
  stripUrlPassword,
  translateHostForContainer,
  verifyChecksum,
  writeChecksum,
} from '../scripts/ops/ops-lib.js';
import { parseArguments as parseRestoreArguments } from '../scripts/ops/restore.js';
import { readBackupStatus } from '../src/observability/backup-status.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'idpn-ops-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('command line parsing', () => {
  // pnpm forwards the separator that follows the script name, so every documented
  // invocation (`pnpm --filter @idpn/api db:rollback -- --yes`) reaches the script with a
  // leading `--`. The CI backup/restore drill failed on exactly that token.
  const DATABASE_URL = 'postgresql://idpn:secret@127.0.0.1:5432/idpn';

  it('ignores a leading -- separator in the ops backup CLI', () => {
    const { options, help } = parseBackupArguments([
      '--',
      '--database-url',
      DATABASE_URL,
      '--output-dir',
      '/tmp/backups',
      '--no-redis',
    ]);
    expect(help).toBe(false);
    expect(options.databaseUrl).toBe(DATABASE_URL);
    expect(options.outputDirectory).toBe('/tmp/backups');
    expect(options.redisUrl).toBeUndefined();
  });

  it('ignores a leading -- separator in the ops restore CLI', () => {
    const parsed = parseRestoreArguments([
      '--',
      '--backup',
      '/tmp/backups/idpn.dump',
      '--drill',
      '--source-url',
      DATABASE_URL,
      '--json',
    ]);
    expect(parsed.options.backupFile).toBe('/tmp/backups/idpn.dump');
    expect(parsed.options.drill).toBe(true);
    expect(parsed.options.sourceUrl).toBe(DATABASE_URL);
    expect(parsed.json).toBe(true);
  });

  it('ignores a leading -- separator and still binds flags with values', () => {
    const args = parseArgs(['--', 'onboard', '--client', 'app-a', '--yes']);
    expect(args.command).toBe('onboard');
    expect(args.positionals).toEqual([]);
    expect(args.values.get('client')).toEqual(['app-a']);
    expect(hasFlag(args, 'yes')).toBe(true);
  });
});

describe('parseDatabaseUrl', () => {
  it('derives the database and the maintenance URL', () => {
    const parsed = parseDatabaseUrl('postgresql://idpn:secret@127.0.0.1:55440/idpn');
    expect(parsed.database).toBe('idpn');
    expect(parsed.maintenanceUrl).toBe('postgresql://idpn:secret@127.0.0.1:55440/postgres');
  });

  it('rejects non-postgres URLs and unsafe database names', () => {
    expect(() => parseDatabaseUrl('mysql://localhost/idpn')).toThrow(/postgres/);
    expect(() => parseDatabaseUrl('not a url')).toThrow(/valid URL/);
    expect(() => parseDatabaseUrl('postgresql://localhost/idpn;drop')).toThrow(/plain database/);
    expect(() => parseDatabaseUrl('postgresql://localhost/')).toThrow(/plain database/);
  });

  it('builds a scratch URL and refuses identifiers outside the allowlist', () => {
    expect(scratchDatabaseUrl('postgresql://localhost/idpn', 'idpn_restore_drill_1')).toBe(
      'postgresql://localhost/idpn_restore_drill_1',
    );
    expect(() => scratchDatabaseUrl('postgresql://localhost/idpn', 'Bad-Name')).toThrow(
      /invalid scratch/,
    );
  });
});

describe('backup naming and retention', () => {
  it('uses a sortable UTC timestamp and the database name', () => {
    const names = backupFileNames(new Date('2026-10-20T00:15:00.000Z'), 'idpn');
    expect(names.timestamp).toBe('20261020T001500Z');
    expect(names.postgres).toBe('postgres-idpn-20261020T001500Z.dump');
    expect(names.redis).toBe('redis-idpn-20261020T001500Z.rdb');
    expect(names.manifest).toBe('manifest-idpn-20261020T001500Z.json');
  });

  it('selects only our own old artifacts for deletion', () => {
    const entries = [
      { name: 'postgres-idpn-20200101T000000Z.dump', mtimeMs: 1 },
      { name: 'redis-idpn-20200101T000000Z.rdb.sha256', mtimeMs: 1 },
      { name: 'manifest-idpn-20200101T000000Z.json', mtimeMs: 1 },
      { name: 'status.json', mtimeMs: 1 },
      { name: 'manual-keep.txt', mtimeMs: 1 },
      { name: 'postgres-idpn-20200101T000000Z.dump', mtimeMs: 10_000 },
    ];
    expect(selectExpiredFiles(entries, 5_000)).toEqual([
      'manifest-idpn-20200101T000000Z.json',
      'postgres-idpn-20200101T000000Z.dump',
      'redis-idpn-20200101T000000Z.rdb.sha256',
    ]);
  });
});

describe('checksums', () => {
  it('writes and verifies a sha256 sidecar', async () => {
    const file = join(directory, 'postgres-idpn-20261020T001500Z.dump');
    await writeFile(file, 'backup-bytes');
    const checksum = await writeChecksum(file);

    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    expect((await readFile(`${file}.sha256`, 'utf8')).trim()).toBe(
      `${checksum}  postgres-idpn-20261020T001500Z.dump`,
    );
    await expect(verifyChecksum(file)).resolves.toMatchObject({
      verified: true,
      expected: checksum,
    });
  });

  it('detects tampering and a missing sidecar', async () => {
    const file = join(directory, 'postgres-idpn-20261020T001500Z.dump');
    await writeFile(file, 'original');
    await writeChecksum(file);
    await writeFile(file, 'tampered');

    const result = await verifyChecksum(file);
    expect(result.verified).toBe(false);
    expect(result.expected).not.toBe(result.actual);

    await expect(verifyChecksum(join(directory, 'missing.dump'))).rejects.toThrow(
      /checksum file not found/,
    );
  });
});

describe('container URL translation', () => {
  it('maps loopback hosts to the Docker host alias and keeps remote hosts', () => {
    expect(translateHostForContainer('postgresql://idpn:idpn@127.0.0.1:55440/idpn')).toContain(
      'host.docker.internal:55440',
    );
    expect(translateHostForContainer('postgresql://idpn:idpn@localhost:5432/idpn')).toContain(
      'host.docker.internal:5432',
    );
    expect(translateHostForContainer('postgresql://idpn:idpn@db.internal:5432/idpn')).toContain(
      'db.internal:5432',
    );
  });

  it('keeps the password out of the command line', () => {
    const credentials = stripUrlPassword('postgresql://idpn:hunter2@127.0.0.1:55440/idpn');
    expect(credentials.password).toBe('hunter2');
    expect(credentials.url).toBe('postgresql://idpn@127.0.0.1:55440/idpn');
    expect(credentials.url).not.toContain('hunter2');

    const withoutPassword = stripUrlPassword('postgresql://idpn@127.0.0.1:55440/idpn');
    expect(withoutPassword.password).toBeUndefined();
  });

  it('rejects an unknown OPS_PG_MODE instead of silently choosing a client', () => {
    const previous = process.env.OPS_PG_MODE;
    process.env.OPS_PG_MODE = 'sqlite';
    try {
      expect(() => detectPostgresAccess()).toThrow(/OPS_PG_MODE/);
    } finally {
      if (previous === undefined) {
        delete process.env.OPS_PG_MODE;
      } else {
        process.env.OPS_PG_MODE = previous;
      }
    }
  });
});

describe('redaction and formatting', () => {
  it('removes URL credentials and key/value secrets', () => {
    const sanitized = redactSecrets(
      'connect postgresql://idpn:hunter2@db:5432/idpn failed password=hunter2 token=abc',
    );
    expect(sanitized).not.toContain('hunter2');
    expect(sanitized).not.toContain('token=abc');
    expect(sanitized).toContain('postgresql://***@db:5432/idpn');
  });

  it('formats sizes for the operator summary', () => {
    expect(formatBytes(10)).toBe('10 B');
    expect(formatBytes(2_048)).toBe('2.0 KiB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MiB');
  });
});

describe('backup status bridge', () => {
  it('reads a status file that the API exposes as the freshness gauge', async () => {
    const statusFile = join(directory, 'status.json');
    await writeFile(
      statusFile,
      JSON.stringify({ lastSuccessAt: '2026-10-20T00:15:00.000Z', targets: ['postgres'] }),
    );
    const status = await readBackupStatus(statusFile);
    expect(status?.lastSuccessAt.toISOString()).toBe('2026-10-20T00:15:00.000Z');
    expect(status?.targets).toEqual(['postgres']);
  });
});

describe('supply-chain gate', () => {
  const runGate = async (): Promise<{ code: number; stderr: string }> => {
    try {
      const result = await execFileAsync(process.execPath, [
        join(REPO_ROOT, 'tools/check-supply-chain.mjs'),
        '--root',
        directory,
      ]);
      return { code: 0, stderr: String(result.stderr) };
    } catch (error) {
      const failed = error as { code?: number; stderr?: string };
      return { code: failed.code ?? 1, stderr: String(failed.stderr ?? '') };
    }
  };

  const writeWorkspace = async (
    root: Record<string, unknown>,
    packages: Record<string, Record<string, unknown>> = {},
  ): Promise<void> => {
    await writeFile(join(directory, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    await writeFile(join(directory, 'package.json'), JSON.stringify(root));
    await mkdir(join(directory, 'packages'), { recursive: true });
    for (const [name, pkg] of Object.entries(packages)) {
      await mkdir(join(directory, 'packages', name), { recursive: true });
      await writeFile(join(directory, 'packages', name, 'package.json'), JSON.stringify(pkg));
    }
  };

  // A gate whose failure paths are never exercised looks green even when it stops working.
  it('fails on a floating dependency range', async () => {
    await writeWorkspace({ name: 'fixture', dependencies: { vite: 'latest' } });

    const result = await runGate();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must not use the floating range');
  });

  it('fails when react is not one exact version across the workspace', async () => {
    await writeWorkspace({ name: 'fixture', dependencies: { react: '19.0.0' } }, {
      a: { name: 'a', dependencies: { react: '19.1.0' } },
    });

    const result = await runGate();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must share one exact version');
  });

  it('passes a pinned fixture', async () => {
    await writeWorkspace({ name: 'fixture', dependencies: { vite: '7.1.0' } }, {
      a: { name: 'a', dependencies: { react: '19.1.0' } },
    });

    const result = await runGate();
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });
});
