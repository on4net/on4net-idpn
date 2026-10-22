import { readFile } from 'node:fs/promises';

/**
 * Backup freshness bridge (docs/monitoring.md).
 *
 * `scripts/ops/backup.ts` writes a small JSON status file after a successful dump; the API
 * reads it during a metrics scrape. Keeping the bridge file-based means the API never
 * needs credentials for the backup store and a missing/old file is visible as the
 * `IdpnBackupStale` alert instead of silently passing.
 */
export interface BackupStatus {
  lastSuccessAt: Date;
  targets: string[];
}

export interface BackupStatusFile {
  lastSuccessAt?: unknown;
  targets?: unknown;
}

export async function readBackupStatus(file: string | undefined): Promise<BackupStatus | null> {
  if (file === undefined || file.trim() === '') {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`backup status file ${file} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`backup status file ${file} must contain a JSON object`);
  }
  const status = parsed as BackupStatusFile;
  if (typeof status.lastSuccessAt !== 'string') {
    throw new Error(`backup status file ${file} is missing lastSuccessAt`);
  }
  const lastSuccessAt = new Date(status.lastSuccessAt);
  if (Number.isNaN(lastSuccessAt.getTime())) {
    throw new Error(`backup status file ${file} has an invalid lastSuccessAt`);
  }
  const targets = Array.isArray(status.targets)
    ? status.targets.filter((target): target is string => typeof target === 'string')
    : [];
  return { lastSuccessAt, targets };
}
