import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedDatabase } from '../src/db/catalog.js';

// The catalog itself lives in src/db/catalog.ts so the install wizard can reuse it without
// pulling dotenv (a dev dependency) into the production runtime.
export { seedDatabase };

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  loadEnv({ path: resolve(here, '..', '.env'), quiet: true });
  loadEnv({ path: resolve(here, '..', '..', '.env'), quiet: true });

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    await seedDatabase(prisma);
    const [tenants, users, clients, roles, permissions] = await Promise.all([
      prisma.tenant.count(),
      prisma.user.count(),
      prisma.client.count(),
      prisma.role.count(),
      prisma.permission.count(),
    ]);
    console.log(
      `Seed complete: ${tenants} tenant(s), ${users} user(s), ${clients} client(s), ` +
        `${roles} role(s), ${permissions} permission(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
