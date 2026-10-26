import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import {
  createKeyringSecretBox,
  loadMfaSecretKeyring,
  loadSocialSecretKeyring,
  type KeyringSecretBox,
} from '../../src/crypto/secret-box.js';
import { hasFlag, parseArgs } from '../cli-args.js';

/**
 * Re-encrypts every stored secret envelope under the current key of its key ring.
 *
 * Run it after rotating `SOCIAL_SECRET_KEY` / `MFA_SECRET_KEY` and before the old key is removed
 * from `*_PREVIOUS_KEYS`: version-1 envelopes (written before the ring) and envelopes naming a
 * superseded key are decrypted with the ring and written back under the current key. The
 * plaintext never leaves the process and is not logged. Idempotent; `--dry-run` only counts.
 */

export interface RewrapTarget {
  name: string;
  box: KeyringSecretBox;
  list(after: string | null, take: number): Promise<{ id: string; envelope: Uint8Array }[]>;
  write(id: string, envelope: Buffer): Promise<void>;
}

export interface RewrapSummary {
  name: string;
  scanned: number;
  rewrapped: number;
  failed: number;
}

export async function rewrapTarget(target: RewrapTarget, dryRun: boolean): Promise<RewrapSummary> {
  const summary: RewrapSummary = { name: target.name, scanned: 0, rewrapped: 0, failed: 0 };
  let after: string | null = null;
  for (;;) {
    const rows = await target.list(after, 200);
    if (rows.length === 0) {
      return summary;
    }
    for (const row of rows) {
      summary.scanned += 1;
      if (!target.box.needsRewrap(row.envelope)) {
        continue;
      }
      try {
        const plaintext = target.box.decrypt(row.envelope);
        if (!dryRun) {
          await target.write(row.id, target.box.encrypt(plaintext));
        }
        summary.rewrapped += 1;
      } catch {
        // An envelope no configured key opens must be surfaced, never silently skipped.
        summary.failed += 1;
      }
    }
    after = rows.at(-1)?.id ?? null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = hasFlag(args, 'dry-run');
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required');
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const targets: RewrapTarget[] = [];
    const social = loadSocialSecretKeyring(process.env);
    if (social !== null) {
      targets.push({
        name: 'client_social_providers.client_secret_encrypted',
        box: createKeyringSecretBox(social),
        list: async (after, take) =>
          (
            await prisma.clientSocialProvider.findMany({
              ...(after === null ? {} : { where: { id: { gt: after } } }),
              orderBy: { id: 'asc' },
              take,
              select: { id: true, clientSecretEncrypted: true },
            })
          ).map((row) => ({ id: row.id, envelope: row.clientSecretEncrypted })),
        write: async (id, envelope) => {
          await prisma.clientSocialProvider.update({
            where: { id },
            data: { clientSecretEncrypted: new Uint8Array(envelope) },
          });
        },
      });
    }
    const mfa = loadMfaSecretKeyring(process.env);
    if (mfa !== null) {
      targets.push({
        name: 'mfa_factors.secret_encrypted',
        box: createKeyringSecretBox(mfa),
        list: async (after, take) =>
          (
            await prisma.mfaFactor.findMany({
              where: {
                secretEncrypted: { not: null },
                ...(after === null ? {} : { id: { gt: after } }),
              },
              orderBy: { id: 'asc' },
              take,
              select: { id: true, secretEncrypted: true },
            })
          ).flatMap((row) =>
            row.secretEncrypted === null ? [] : [{ id: row.id, envelope: row.secretEncrypted }],
          ),
        write: async (id, envelope) => {
          await prisma.mfaFactor.update({
            where: { id },
            data: { secretEncrypted: new Uint8Array(envelope) },
          });
        },
      });
    }
    const summaries: RewrapSummary[] = [];
    for (const target of targets) {
      summaries.push(await rewrapTarget(target, dryRun));
    }
    console.log(JSON.stringify({ dryRun, summaries }, null, 2));
    process.exitCode = summaries.some((entry) => entry.failed > 0) ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(resolve(entrypoint)).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
