import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { hashPassword } from '../src/auth/password.js';
import { seedDatabase } from '../prisma/seed.js';

/**
 * Fixtures for the load/performance suite (`tools/perf`, issue #47).
 *
 * Everything here is a local benchmark fixture: no production identifier, no real
 * credential and no committed secret. Values come from the environment with documented
 * defaults, and every write is idempotent so repeated runs do not churn rows.
 *
 * The benchmark API is started with `ADMIN_CLIENT_ID=perf-admin`, so the issued access
 * token targets the fixture client rather than the real admin panel. The fixture user is
 * granted the seeded `idp:superadmin` role, which is what the Admin API authorization
 * check ultimately reads.
 *
 * Never point this at a production database.
 */

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '..', '.env'), quiet: true });
loadEnv({ path: resolve(here, '..', '..', '.env'), quiet: true });

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://idpn:idpn@127.0.0.1:55440/idpn';

const ADMIN_CLIENT_ID = process.env['PERF_ADMIN_CLIENT_ID'] ?? 'perf-admin';
const ADMIN_CLIENT_SECRET = process.env['PERF_ADMIN_CLIENT_SECRET'] ?? 'perf-admin-client-secret';
const APP_CLIENT_ID = process.env['PERF_APP_CLIENT_ID'] ?? 'perf-app';
const APP_CLIENT_SECRET = process.env['PERF_APP_CLIENT_SECRET'] ?? 'perf-app-client-secret';
const USER_EMAIL = process.env['PERF_USER_IDENTIFIER'] ?? 'perf@example.com';
const USER_PASSWORD = process.env['PERF_USER_PASSWORD'] ?? 'perf-user-password-123';
const REDIRECT_URI = process.env['PERF_REDIRECT_URI'] ?? 'http://127.0.0.1:3999/callback';
const SSO_REDIRECT_URI = process.env['PERF_SSO_REDIRECT_URI'] ?? 'http://127.0.0.1:3998/callback';
/** Extra users make the paginated Admin API list representative without Argon2 cost. */
const DIRECTORY_USERS = Number(process.env['PERF_DIRECTORY_USERS'] ?? 250);

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });

async function upsertClient(input: {
  clientId: string;
  name: string;
  secret: string;
  redirectUris: string[];
  scopes: string[];
  tenantId: string;
}): Promise<void> {
  const data = {
    name: input.name,
    type: 'web' as const,
    redirectUris: input.redirectUris,
    postLogoutRedirectUris: [],
    allowedOrigins: input.redirectUris.map((uri) => new URL(uri).origin),
    scopes: input.scopes,
    requirePkce: true,
    registrationPolicy: 'disabled' as const,
    mfaPolicy: 'optional' as const,
    status: 'active' as const,
    tenantId: input.tenantId,
  };
  await prisma.client.upsert({
    where: { clientId: input.clientId },
    update: data,
    create: { clientId: input.clientId, ...data },
  });

  const client = await prisma.client.findUniqueOrThrow({
    where: { clientId: input.clientId },
    select: { id: true, clientId: true },
  });
  const secretHash = await hashPassword(input.secret);
  const active = await prisma.clientSecret.findMany({
    where: { clientId: client.id, revokedAt: null },
    select: { id: true, secretHash: true },
  });
  if (active.length === 1 && active[0]?.secretHash === secretHash) {
    return;
  }
  await prisma.clientSecret.updateMany({
    where: { clientId: client.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await prisma.clientSecret.create({
    data: {
      clientId: client.id,
      secretHash,
      prefix: `perf-${client.clientId}`.slice(0, 16),
    },
  });
}

async function seedBenchmarkFixtures(): Promise<void> {
  await seedDatabase(prisma);

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'default' } });

  await upsertClient({
    clientId: ADMIN_CLIENT_ID,
    name: 'IDPN Performance Admin (fixture)',
    secret: ADMIN_CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
    scopes: ['openid', 'profile', 'email', 'idp.admin', 'offline_access'],
    tenantId: tenant.id,
  });
  await upsertClient({
    clientId: APP_CLIENT_ID,
    name: 'IDPN Performance App (fixture)',
    secret: APP_CLIENT_SECRET,
    redirectUris: [SSO_REDIRECT_URI],
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    tenantId: tenant.id,
  });

  const user = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: USER_EMAIL } },
    update: {
      status: 'active',
      passwordHash: await hashPassword(USER_PASSWORD),
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
      deletedAt: null,
    },
    create: {
      tenantId: tenant.id,
      username: 'perf-user',
      email: USER_EMAIL,
      displayName: 'Performance User',
      emailVerifiedAt: new Date(),
      locale: 'fa-IR',
      status: 'active',
      passwordHash: await hashPassword(USER_PASSWORD),
      passwordChangedAt: new Date(),
    },
  });

  const superadmin = await prisma.role.findUniqueOrThrow({
    where: { key: 'idp:superadmin' },
    select: { id: true },
  });
  const assignment = await prisma.assignment.findFirst({
    where: {
      subjectType: 'user',
      subjectId: user.id,
      roleId: superadmin.id,
      scopeType: 'global',
      scopeId: null,
    },
    select: { id: true },
  });
  if (assignment === null) {
    await prisma.assignment.create({
      data: {
        subjectType: 'user',
        subjectId: user.id,
        roleId: superadmin.id,
        scopeType: 'global',
        scopeId: null,
        assignedBy: user.id,
      },
    });
  }

  // The base seed gives every client a default login context, so authorize requires an
  // active client-wide membership for an unbound request. Creating it keeps the benchmark
  // on the ordinary flow instead of a context-bound one.
  for (const clientId of [ADMIN_CLIENT_ID, APP_CLIENT_ID]) {
    const client = await prisma.client.findUniqueOrThrow({
      where: { clientId },
      select: { id: true },
    });
    const membership = await prisma.clientMembership.findFirst({
      where: { clientId: client.id, loginContextId: null, userId: user.id },
      select: { id: true },
    });
    if (membership === null) {
      await prisma.clientMembership.create({
        data: {
          clientId: client.id,
          loginContextId: null,
          userId: user.id,
          status: 'active',
          joinedAt: new Date(),
        },
      });
    } else {
      await prisma.clientMembership.update({
        where: { id: membership.id },
        data: { status: 'active' },
      });
    }
  }

  if (DIRECTORY_USERS > 0) {
    const base = new Date('2026-01-01T00:00:00Z');
    await prisma.user.createMany({
      data: Array.from({ length: DIRECTORY_USERS }, (_, index) => ({
        tenantId: tenant.id,
        username: `perf-directory-${String(index).padStart(4, '0')}`,
        email: `perf-directory-${String(index).padStart(4, '0')}@example.com`,
        displayName: `Directory User ${String(index).padStart(4, '0')}`,
        emailVerifiedAt: base,
        locale: 'fa-IR',
        status: 'active' as const,
      })),
      skipDuplicates: true,
    });
  }

  // One per-client override makes the public bundle non-empty; the key comes from the base
  // bundle so the response stays valid if the base catalog changes.
  const appClient = await prisma.client.findUniqueOrThrow({
    where: { clientId: APP_CLIENT_ID },
    select: { id: true },
  });
  await prisma.clientTranslation.upsert({
    where: {
      clientId_locale_key: {
        clientId: appClient.id,
        locale: 'fa-IR',
        key: 'errors.clientIdRequired',
      },
    },
    update: { value: 'perf-client-id لازم است.' },
    create: {
      clientId: appClient.id,
      locale: 'fa-IR',
      key: 'errors.clientIdRequired',
      value: 'perf-client-id لازم است.',
    },
  });

  console.log(
    `Performance fixtures ready: admin=${ADMIN_CLIENT_ID}, app=${APP_CLIENT_ID}, ` +
      `user=${USER_EMAIL}, directory users=${DIRECTORY_USERS}.`,
  );
}

try {
  await seedBenchmarkFixtures();
} finally {
  await prisma.$disconnect();
}
