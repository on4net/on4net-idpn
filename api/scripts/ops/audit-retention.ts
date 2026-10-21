import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import { flagValue, hasFlag, parseArgs } from '../cli-args.js';

/**
 * Audit retention (docs/security.md 10, docs/domain-model.md 4).
 *
 * The table is append-only, so pruning needs two explicit things: the operator's `--yes` and
 * the session-local `idpn.audit_maintenance` switch that the BEFORE DELETE/TRUNCATE trigger
 * checks. Both run inside one transaction, so `set_config(..., true)` cannot leak to another
 * pooled connection. History may be pruned; rows are never rewritten.
 */
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '..', '..', '.env'), quiet: true });
loadEnv({ path: resolve(here, '..', '..', '..', '.env'), quiet: true });

const args = parseArgs(process.argv.slice(2));

if (!hasFlag(args, 'yes')) {
  console.error(
    'audit-retention deletes audit rows older than the retention window.\n' +
      'Re-run with --yes to confirm: pnpm --filter @idpn/api ops:audit-retention -- --yes [--months 12]',
  );
  process.exit(1);
}

const monthsFlag = flagValue(args, 'months');
const months = monthsFlag === undefined ? 12 : Number(monthsFlag);
if (!Number.isInteger(months) || months < 1) {
  console.error('--months must be a positive integer (default 12).');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const cutoff = new Date();
cutoff.setMonth(cutoff.getUTCMonth() - months);

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
try {
  const deleted = await prisma.$transaction(async (tx) => {
    // Transaction-local: the switch disappears when this transaction ends.
    await tx.$executeRaw`SELECT set_config('idpn.audit_maintenance', 'on', true)`;
    return tx.$executeRaw`DELETE FROM "audit_events" WHERE "occurred_at" < ${cutoff}`;
  });
  console.log(`Deleted ${deleted} audit event(s) older than ${cutoff.toISOString()}.`);
} finally {
  await prisma.$disconnect();
}
