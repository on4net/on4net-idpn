import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';

import { loadApiEnv } from './config/env.js';
import { createPrismaAdminAudit } from './admin/prisma-audit.js';
import { createPrismaAdminClientRepository } from './admin/clients/prisma-client-repository.js';
import { createPrismaPermissionReader } from './admin/prisma-permission-reader.js';
import { createPrismaRbacRepository } from './admin/rbac/prisma-rbac-repository.js';
import { createPrismaMemberRepository } from './admin/members/prisma-member-repository.js';
import { createPrismaAuditEventRepository } from './admin/audit/prisma-audit-repository.js';
import { createPrismaAdminSessionRepository } from './admin/sessions/prisma-session-repository.js';
import { createPrismaEffectiveAccessSource } from './oidc/effective-access.js';
import {
  BackchannelLogoutDispatcher,
  FetchBackchannelLogoutSender,
  RedisBackchannelLogoutQueue,
} from './oidc/backchannel-logout.js';
import { LogoutTokenSigner, RedisLogoutTokenJtiRegistry } from './oidc/logout-token.js';
import { createPrismaLogoutRepository } from './oidc/prisma-logout-repository.js';
import { createPrismaAdminUserRepository } from './admin/prisma-user-repository.js';
import { PrismaClient } from './generated/prisma/client.js';
import { FileSigningKeyRepository } from './oidc/file-key-repository.js';
import { SigningKeyManager } from './oidc/keys.js';
import { createPrismaClientRepository } from './oidc/prisma-client-repository.js';
import { createPrismaCodeRepository } from './oidc/prisma-code-repository.js';
import { createPrismaRefreshTokenRepository } from './oidc/prisma-refresh-repository.js';
import { createPrismaUserRepository } from './oidc/prisma-user-repository.js';
import { createPrismaPublicConfigRepository } from './public-config/prisma-repository.js';
import { createPrismaLoginRepository } from './login/prisma-repository.js';
import { buildServer } from './server.js';
import { createPrismaSessionRevocationHook } from './session/prisma-revocation.js';
import { RedisSessionCache } from './session/redis-cache.js';
import { RedisSessionStore } from './session/store.js';

const env = loadApiEnv();

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });

// Development key store (git-ignored). Production points SIGNING_KEY_REF at KMS/Vault.
const keys = new SigningKeyManager(new FileSigningKeyRepository('.idpn-keys.json'));
await keys.ensureKey();

const sessions = new RedisSessionStore({
  cache: new RedisSessionCache(redis),
  policy: {
    idleTtlSeconds: env.SESSION_IDLE_TTL_SECONDS,
    absoluteTtlSeconds: env.SESSION_ABSOLUTE_TTL_SECONDS,
    maxConcurrentSessions: env.SESSION_MAX_CONCURRENT,
  },
  // Automatic revocations (currently the concurrent-session limit) are mirrored and
  // audited here; explicit admin/logout/password revocations are audited by their route.
  onRevoked: createPrismaSessionRevocationHook(prisma),
});

const clientsRepository = createPrismaClientRepository(prisma);
const usersRepository = createPrismaUserRepository(prisma);
const loginRepository = createPrismaLoginRepository(prisma);
const permissionReader = createPrismaPermissionReader(prisma);
const rbacRepository = createPrismaRbacRepository(prisma);
const membersRepository = createPrismaMemberRepository(prisma, {
  rbac: rbacRepository,
  sessions,
});
const effectiveAccess = createPrismaEffectiveAccessSource(prisma);

/**
 * Back-channel logout is best effort: retries with backoff, then the durable Redis queue
 * that the retry worker drains. A client failure must never affect the user's logout.
 */
const backchannelLogout = new BackchannelLogoutDispatcher({
  tokens: new LogoutTokenSigner({
    issuer: env.APP_URL,
    keys,
    registry: new RedisLogoutTokenJtiRegistry(redis),
  }),
  sender: new FetchBackchannelLogoutSender(),
  queue: new RedisBackchannelLogoutQueue(redis),
  onError: (error, context) => {
    // Never log token material, only the client and the phase that failed.
    const reason = error instanceof Error ? error.message : 'unknown error';
    console.error(`back-channel logout ${context.phase} failed for ${context.clientId}: ${reason}`);
  },
});

/** A user may receive `idp.client-admin` only with at least one scoped admin permission. */
const isClientAdminEligible = async (userId: string, clientId: string): Promise<boolean> =>
  ((await permissionReader.clientPermissionsForUser?.(userId, clientId)) ?? []).length > 0;

const app = buildServer({
  issuer: env.APP_URL,
  keys,
  token: {
    clients: clientsRepository,
    codes: createPrismaCodeRepository(prisma),
    refreshTokens: createPrismaRefreshTokenRepository(prisma),
    users: usersRepository,
    sessions,
    isClientAdminEligible,
    access: effectiveAccess,
  },
  userInfo: { users: usersRepository, access: effectiveAccess },
  authorize: {
    clients: clientsRepository,
    loginUrl: `${(env.HOSTED_UI_URL ?? env.APP_URL).replace(/\/+$/, '')}/`,
    isClientAdminEligible,
  },
  login: {
    users: loginRepository,
    sessions,
    persistSession: (input) => loginRepository.persistSession(input),
    audit: { record: (event) => loginRepository.record(event) },
    cookie: {
      secure: env.APP_URL.startsWith('https://'),
      idleTtlSeconds: env.SESSION_IDLE_TTL_SECONDS,
      absoluteTtlSeconds: env.SESSION_ABSOLUTE_TTL_SECONDS,
    },
  },
  logout: {
    clients: clientsRepository,
    sessions,
    revocations: createPrismaLogoutRepository(prisma),
    backchannel: backchannelLogout,
    audit: { record: (event) => loginRepository.record(event) },
    cookie: { secure: env.APP_URL.startsWith('https://') },
  },
  publicConfig: {
    repository: createPrismaPublicConfigRepository(prisma),
    originLookup: (clientId) => clientsRepository.findAllowedOrigins(clientId),
    mfe: {
      version: env.MFE_VERSION,
      remoteEntry: `${(env.MFE_PUBLIC_URL ?? env.APP_URL).replace(/\/+$/, '')}/${env.MFE_VERSION}/remoteEntry.js`,
    },
    translationsUrlTemplate: `${env.APP_URL.replace(/\/+$/, '')}/api/v1/clients/{clientId}/translations/bundle`,
  },
  admin: {
    adminClientId: env.ADMIN_CLIENT_ID,
    permissions: permissionReader,
    users: createPrismaAdminUserRepository(prisma),
    audit: createPrismaAdminAudit(prisma),
    sessions,
  },
  adminClients: {
    adminClientId: env.ADMIN_CLIENT_ID,
    permissions: permissionReader,
    clients: createPrismaAdminClientRepository(prisma),
    audit: createPrismaAdminAudit(prisma),
  },
  rbac: {
    adminClientId: env.ADMIN_CLIENT_ID,
    permissions: permissionReader,
    rbac: rbacRepository,
    audit: createPrismaAdminAudit(prisma),
  },
  adminMembers: {
    adminClientId: env.ADMIN_CLIENT_ID,
    permissions: permissionReader,
    members: membersRepository,
    audit: createPrismaAdminAudit(prisma),
  },
  audit: {
    adminClientId: env.ADMIN_CLIENT_ID,
    permissions: permissionReader,
    events: createPrismaAuditEventRepository(prisma),
    audit: createPrismaAdminAudit(prisma),
  },
  adminSessions: {
    adminClientId: env.ADMIN_CLIENT_ID,
    permissions: permissionReader,
    repository: createPrismaAdminSessionRepository(prisma),
    revoker: sessions,
    audit: createPrismaAdminAudit(prisma),
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => prisma.$disconnect())
      .then(() => redis.quit())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
console.log(`on4net IDPN API listening on http://${env.HOST}:${env.PORT}`);
