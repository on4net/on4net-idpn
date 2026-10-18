import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

const here = dirname(fileURLToPath(import.meta.url));

// api/.env wins over the repository root .env; both are optional for CI, where the
// variables are usually provided by the environment itself.
loadEnv({ path: resolve(here, '.env'), quiet: true });
loadEnv({ path: resolve(here, '..', '.env'), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
