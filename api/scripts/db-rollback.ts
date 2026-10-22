import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';

import { rollbackLatestMigration } from '../src/db/rollback.js';
import { hasFlag, parseArgs } from './cli-args.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '..', '.env'), quiet: true });
loadEnv({ path: resolve(here, '..', '..', '.env'), quiet: true });

const args = parseArgs(process.argv.slice(2));

// `down.sql` can drop tables, so the destructive path is never implicit: an operator has to
// confirm with `--yes`, and a production database additionally needs `--force`.
if (!hasFlag(args, 'yes')) {
  console.error(
    'db:rollback runs the down.sql of the latest applied migration and can drop tables.\n' +
      'Re-run with --yes to confirm: pnpm --filter @idpn/api db:rollback -- --yes',
  );
  process.exit(1);
}

if (process.env.NODE_ENV === 'production' && !hasFlag(args, 'force')) {
  console.error(
    'Refusing to roll back a production database (NODE_ENV=production).\n' +
      'Pass --force as well if this is genuinely intended.',
  );
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const migration = await rollbackLatestMigration({ connectionString, confirm: true });
if (migration === null) {
  console.error('Nothing to roll back: no applied migration.');
  process.exit(1);
}

console.log(`Rolled back migration ${migration}. Re-apply it with db:deploy.`);
