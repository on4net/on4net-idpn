import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { hashPassword } from '../src/auth/password.js';
import { seedDatabase } from '../prisma/seed.js';

/**
 * Fixtures for the browser end-to-end suite (`playwright test`).
 *
 * The base seed deliberately creates password-less users, so the E2E run provisions one
 * login credential and one confidential client for the sample BFF. Everything is an upsert
 * and every value comes from the environment, so the script is idempotent and holds no
 * committed secret. Never point this at a production database.
 */
const E2E_CLIENT_ID = process.env['E2E_BFF_CLIENT_ID'] ?? 'sample-bff';
const E2E_REDIRECT_URI =
  process.env['E2E_BFF_REDIRECT_URI'] ?? 'http://127.0.0.1:3200/auth/callback';
const E2E_POST_LOGOUT_URI =
  process.env['E2E_BFF_POST_LOGOUT_URI'] ?? 'http://127.0.0.1:3200/signed-out';
const E2E_CLIENT_SECRET = process.env['E2E_BFF_CLIENT_SECRET'] ?? 'e2e-bff-client-secret';
const E2E_USER_IDENTIFIER = process.env['E2E_USER_IDENTIFIER'] ?? 'user@example.com';
const E2E_USER_PASSWORD = process.env['E2E_USER_PASSWORD'] ?? 'e2e-user-password-123';
/**
 * Second app used by the SSO/logout scenario: no second login page is started, the test only
 * proves that `/oauth2/authorize` issues a code for this client from the existing IdP session.
 */
const E2E_SECOND_CLIENT_ID = process.env['E2E_SECOND_CLIENT_ID'] ?? 'sample-bff-b';
const E2E_SECOND_REDIRECT_URI =
  process.env['E2E_SECOND_REDIRECT_URI'] ?? 'http://127.0.0.1:3201/auth/callback';

async function upsertWebClient(
  prisma: PrismaClient,
  tenantId: string,
  input: {
    clientId: string;
    name: string;
    redirectUri: string;
    postLogoutRedirectUris: string[];
  },
): Promise<void> {
  const data = {
    name: input.name,
    type: 'web' as const,
    redirectUris: [input.redirectUri],
    postLogoutRedirectUris: [...input.postLogoutRedirectUris],
    allowedOrigins: [new URL(input.redirectUri).origin],
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    requirePkce: true,
    registrationPolicy: 'disabled' as const,
    mfaPolicy: 'optional' as const,
    status: 'active' as const,
    tenantId,
  };
  await prisma.client.upsert({
    where: { clientId: input.clientId },
    update: data,
    create: { clientId: input.clientId, ...data },
  });
}

async function seedE2eFixtures(prisma: PrismaClient): Promise<void> {
  await seedDatabase(prisma);

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'default' } });

  await upsertWebClient(prisma, tenant.id, {
    clientId: E2E_CLIENT_ID,
    name: 'Sample BFF (E2E)',
    redirectUri: E2E_REDIRECT_URI,
    postLogoutRedirectUris: [E2E_POST_LOGOUT_URI],
  });
  await upsertWebClient(prisma, tenant.id, {
    clientId: E2E_SECOND_CLIENT_ID,
    name: 'Sample BFF B (E2E)',
    redirectUri: E2E_SECOND_REDIRECT_URI,
    postLogoutRedirectUris: [],
  });

  const client = await prisma.client.findUniqueOrThrow({ where: { clientId: E2E_CLIENT_ID } });

  const secretHash = await hashPassword(E2E_CLIENT_SECRET);
  const activeSecrets = await prisma.clientSecret.findMany({
    where: { clientId: client.id, revokedAt: null },
  });
  if (activeSecrets.length === 1 && activeSecrets[0]?.secretHash === secretHash) {
    // Unchanged secret: keep the row so repeated runs do not churn the table.
  } else {
    await prisma.clientSecret.updateMany({
      where: { clientId: client.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await prisma.clientSecret.create({
      data: {
        clientId: client.id,
        secretHash,
        prefix: `e2e-${client.clientId}`.slice(0, 16),
      },
    });
  }

  const user = await prisma.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email: E2E_USER_IDENTIFIER, deletedAt: null },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(E2E_USER_PASSWORD),
      status: 'active',
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  /**
   * `/oauth2/authorize` fails closed for a client with active login contexts when the user
   * holds no active membership for the requested scope (CTX-003, `api/src/oidc/authorize-route.ts`).
   * The Hosted UI binds the context it resolved (`withLoginContext`), so the fixture needs an
   * active membership in the client's default context; the client-wide row keeps the unbound
   * authorize path covered as well. Idempotent.
   */
  for (const clientId of [E2E_CLIENT_ID, E2E_SECOND_CLIENT_ID]) {
    const seededClient = await prisma.client.findUniqueOrThrow({ where: { clientId } });
    const defaultContext = await prisma.clientLoginContext.findFirst({
      where: { clientId: seededClient.id, isDefault: true },
      select: { id: true },
    });
    const scopes: (string | null)[] = defaultContext === null ? [null] : [null, defaultContext.id];
    for (const loginContextId of scopes) {
      const membership = await prisma.clientMembership.findFirst({
        where: { clientId: seededClient.id, userId: user.id, loginContextId },
      });
      if (membership === null) {
        await prisma.clientMembership.create({
          data: {
            clientId: seededClient.id,
            userId: user.id,
            loginContextId,
            status: 'active',
            joinedAt: new Date(),
            invitedAt: new Date(),
          },
        });
      } else if (membership.status !== 'active') {
        await prisma.clientMembership.update({
          where: { id: membership.id },
          data: { status: 'active' },
        });
      }
    }
  }

  console.log(
    `E2E fixtures ready: client ${E2E_CLIENT_ID} -> ${E2E_REDIRECT_URI}, user ${E2E_USER_IDENTIFIER}.`,
  );
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  loadEnv({ path: resolve(here, '..', '.env'), quiet: true });
  loadEnv({ path: resolve(here, '..', '..', '.env'), quiet: true });

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    await seedE2eFixtures(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
