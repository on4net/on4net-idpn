import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBackup } from '../scripts/ops/backup.js';
import { detectPostgresAccess, type PostgresAccess } from '../scripts/ops/ops-lib.js';
import { runRestore } from '../scripts/ops/restore.js';
import { readBackupStatus } from '../src/observability/backup-status.js';

/**
 * End-to-end backup/restore drill against an existing test server (`TEST_DATABASE_URL`).
 * It creates and drops a scratch database; the dump itself is written to a temporary
 * directory. Without a reachable PostgreSQL client (local binaries or Docker) the suite is
 * skipped with an explicit reason instead of silently passing.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
let access: PostgresAccess | null = null;
try {
  access = databaseUrl === '' ? null : detectPostgresAccess();
} catch {
  access = null;
}

const enabled = databaseUrl !== '' && access !== null;

describe.skipIf(!enabled)('backup and restore drill', () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'idpn-restore-drill-'));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('dumps PostgreSQL, writes a freshness status and restores into a verified scratch DB', async () => {
    if (access === null) {
      throw new Error('PostgreSQL tooling is unavailable');
    }
    const backup = await runBackup({
      databaseUrl,
      outputDirectory: directory,
      access,
      retentionDays: 1,
      log: () => undefined,
    });

    expect(backup.targets).toEqual(['postgres']);
    expect(backup.files).toHaveLength(1);
    const dump = backup.files[0];
    expect(dump).toBeDefined();
    if (dump === undefined) {
      return;
    }
    expect(dump.name).toMatch(/postgres-.*\.dump$/);
    expect(dump.bytes).toBeGreaterThan(0);
    expect(dump.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(dump.name)).size).toBe(dump.bytes);

    const status = await readBackupStatus(backup.statusFile);
    expect(status?.targets).toEqual(['postgres']);
    expect(status?.lastSuccessAt.toISOString()).toBe(backup.createdAt);

    const restore = await runRestore({
      backupFile: dump.name,
      sourceUrl: databaseUrl,
      drill: true,
      access,
      log: () => undefined,
    });

    expect(restore.restored).toBe(true);
    expect(restore.checksumVerified).toBe(true);
    expect(restore.scratchDatabase).toMatch(/^idpn_restore_drill_/);
    expect(restore.rtoSeconds).toBeGreaterThan(0);
    expect(restore.counts.users?.target).toBe(restore.counts.users?.source);
    expect(restore.counts.clients?.target).toBe(restore.counts.clients?.source);
    expect(restore.counts.audit_events?.target).toBe(restore.counts.audit_events?.source);
    expect(Object.keys(restore.counts).length).toBeGreaterThanOrEqual(10);
  }, 300_000);

  it('refuses to restore a dump whose checksum does not match', async () => {
    if (access === null) {
      throw new Error('PostgreSQL tooling is unavailable');
    }
    const backup = await runBackup({
      databaseUrl,
      outputDirectory: directory,
      access,
      retentionDays: 1,
      log: () => undefined,
    });
    const dump = backup.files[0];
    expect(dump).toBeDefined();
    if (dump === undefined) {
      return;
    }

    const sidecar = `${dump.name}.sha256`;
    const original = await readFile(sidecar, 'utf8');
    await writeFile(sidecar, `${'0'.repeat(64)}  ${dump.name.split(/[\\/]/).at(-1) ?? ''}\n`);

    await expect(
      runRestore({
        backupFile: dump.name,
        sourceUrl: databaseUrl,
        drill: true,
        access,
        log: () => undefined,
      }),
    ).rejects.toThrow(/checksum mismatch/);

    await writeFile(sidecar, original);
  }, 300_000);

  it('refuses a non-scratch target without the explicit override', async () => {
    if (access === null) {
      throw new Error('PostgreSQL tooling is unavailable');
    }
    const backup = await runBackup({
      databaseUrl,
      outputDirectory: directory,
      access,
      retentionDays: 1,
      log: () => undefined,
    });
    const dump = backup.files[0];
    expect(dump).toBeDefined();
    if (dump === undefined) {
      return;
    }

    const target = new URL(databaseUrl);
    target.pathname = '/idpn_production_like';
    await expect(
      runRestore({
        backupFile: dump.name,
        sourceUrl: databaseUrl,
        targetUrl: target.toString(),
        access,
        log: () => undefined,
      }),
    ).rejects.toThrow(/allow-non-scratch/);
  }, 300_000);
});
