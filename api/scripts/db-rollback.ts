import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';

import { rollbackLatestMigration } from '../src/db/rollback.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '..', '.env'), quiet: true });
loadEnv({ path: resolve(here, '..', '..', '.env'), quiet: true });

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const migration = await rollbackLatestMigration({ connectionString });
if (migration === null) {
  console.error('Nothing to roll back: no applied migration.');
  process.exit(1);
}

console.log(`Rolled back migration ${migration}.`);
