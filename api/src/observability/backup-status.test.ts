import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBackupStatus } from './backup-status.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'idpn-backup-status-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('readBackupStatus', () => {
  it('reads the timestamp and targets written by the backup job', async () => {
    const file = join(directory, 'status.json');
    await writeFile(
      file,
      JSON.stringify({
        lastSuccessAt: '2026-10-20T00:15:00.000Z',
        targets: ['postgres', 'redis'],
      }),
    );

    await expect(readBackupStatus(file)).resolves.toMatchObject({
      lastSuccessAt: new Date('2026-10-20T00:15:00.000Z'),
      targets: ['postgres', 'redis'],
    });
  });

  it('returns null when the file is not configured or missing', async () => {
    await expect(readBackupStatus(undefined)).resolves.toBeNull();
    await expect(readBackupStatus('')).resolves.toBeNull();
    await expect(readBackupStatus(join(directory, 'missing.json'))).resolves.toBeNull();
  });

  it('rejects a malformed status file instead of reporting a fake timestamp', async () => {
    const file = join(directory, 'bad.json');
    await writeFile(file, 'not json');
    await expect(readBackupStatus(file)).rejects.toThrow(/not valid JSON/);

    await writeFile(file, JSON.stringify({ lastSuccessAt: 'yesterday' }));
    await expect(readBackupStatus(file)).rejects.toThrow(/invalid lastSuccessAt/);

    await writeFile(file, JSON.stringify({}));
    await expect(readBackupStatus(file)).rejects.toThrow(/missing lastSuccessAt/);
  });

  it('drops non-string target entries', async () => {
    const file = join(directory, 'targets.json');
    await writeFile(
      file,
      JSON.stringify({ lastSuccessAt: '2026-10-20T00:15:00.000Z', targets: ['postgres', 7] }),
    );
    await expect(readBackupStatus(file)).resolves.toMatchObject({ targets: ['postgres'] });
  });
});
