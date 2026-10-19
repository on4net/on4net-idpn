import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';

import { createPrismaAccountProfileRepository } from './account/prisma-account-repository.js';
import { createAccountLifecycle } from './account/lifecycle.js';
import { createPrismaLifecycleUserStore } from './account/prisma-lifecycle-repository.js';
import { createPrismaAccountTokenStore } from './account/prisma-token-repository.js';
import { createMailer } from './mail/index.js';
import { createRedisRateLimiter } from './http/rate-limit.js';
import { loadApiEnv } from './config/env.js';
import { createPrismaAdminAudit } from './admin/prisma-audit.js';
import { createPrismaPasswordStore } from './audit/prisma-audit.js';
import { createPrismaAdminClientRepository } from './admin/clients/prisma-client-repository.js';
import { createPrismaAdminTranslationRepository } from './admin/translations/prisma-translation-repository.js';
import { createPrismaPermissionReader } from './admin/prisma-permission-reader.js';
import { createPrismaRbacRepository } from './admin/rbac/prisma-rbac-repository.js';
import { createPrismaMemberRepository } from './admin/members/prisma-member-repository.js';
import { createPrismaLoginContextRepository } from './admin/login-contexts/prisma-login-context-repository.js';
import { createPrismaAuditEventRepository } from './admin/audit/prisma-audit-repository.js';
import { createPrismaAdminSessionRepository } from './admin/sessions/prisma-session-repository.js';
import { createPrismaSocialProviderRepository } from './admin/social-providers/prisma-social-provider-repository.js';
import { createSecretBox, loadMfaSecretKey, loadSocialSecretKey } from './crypto/secret-box.js';
import { createPrismaSocialLoginRepository } from './social/prisma-social-login-repository.js';
import { RedisSocialTransactionStore } from './social/transaction-store.js';
import { FacebookSocialAdapter } from './social/facebook.js';
import { GoogleSocialAdapter } from './social/google.js';
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
import { KeyRotationScheduler } from './oidc/key-rotation-scheduler.js';
import { DEFAULT_ROTATION_DUE_DAYS, SigningKeyManager } from './oidc/keys.js';
import { createPrismaClientRepository } from './oidc/prisma-client-repository.js';
import {
  createAuthorizeAuthenticationRequirement,
  createAuthorizeMembershipStatus,
} from './oidc/authorize-enforcement.js';
import { createPrismaLoginContextAccessSource } from './oidc/login-context-access.js';
import { createPrismaCodeRepository } from './oidc/prisma-code-repository.js';
import { createPrismaRefreshTokenRepository } from './oidc/prisma-refresh-repository.js';
import { createPrismaUserRepository } from './oidc/prisma-user-repository.js';
import { createPrismaPublicConfigRepository } from './public-config/prisma-repository.js';
import { createRedisBundleCache } from './translations/cache.js';
import { createPrismaPublicTranslationRepository } from './translations/prisma-repository.js';
import { createPrismaLoginRepository } from './login/prisma-repository.js';
import { createPrismaMfaRepository } from './mfa/prisma-repository.js';
import { RedisMfaChallengeStore } from './mfa/challenge-store.js';
import { RedisWebauthnChallengeStore } from './mfa/webauthn-challenge-store.js';
import { SimpleWebauthnLibrary } from './mfa/webauthn-library.js';
import { resolveWebauthnConfig } from './mfa/webauthn.js';
import { verifyPassword } from './auth/password.js';
import { buildServer } from './server.js';
import { createPrismaSessionRevocationHook } from './session/prisma-revocation.js';
import { RedisSessionCache } from './session/redis-cache.js';
import { RedisSessionStore } from './session/store.js';

const env = loadApiEnv();

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });

// Development key store (git-ignored). Production points SIGNING_KEY_REF at KMS/Vault.
// When scheduled rotation is disabled the health flag still reports a rotation after the
// documented 90-day threshold, so operators keep getting an alert.
const keys = new SigningKeyManager(
  new FileSigningKeyRepository('.idpn-keys.json'),
  () => new Date(),
  {
    retiredRetentionSeconds: env.KEY_RETIRED_RETENTION_SECONDS,
    rotationDueAfterDays:
      env.KEY_ROTATION_INTERVAL_DAYS > 0
        ? env.KEY_ROTATION_INTERVAL_DAYS
        : DEFAULT_ROTATION_DUE_DAYS,
    onWarning: (message) => console.warn(`signing key: ${message}`),
  },
);
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
const adminTranslationsRepository = createPrismaAdminTranslationRepository(prisma);
const publicTranslationsRepository = createPrismaPublicTranslationRepository(prisma);
const translationBundleCache = createRedisBundleCache(redis);
const usersRepository = createPrismaUserRepository(prisma);
const loginRepository = createPrismaLoginRepository(prisma);
const permissionReader = createPrismaPermissionReader(prisma);
const rbacRepository = createPrismaRbacRepository(prisma);
const membersRepository = createPrismaMemberRepository(prisma, {
  rbac: rbacRepository,
  sessions,
});
const effectiveAccess = createPrismaEffectiveAccessSource(prisma);
const adminSessionsRepository = createPrismaAdminSessionRepository(prisma);
/** Password changes keep the caller's session but revoke every other session and token. */
const passwordStore = createPrismaPasswordStore(prisma, { sessions });

/**
 * Account lifecycle mail (invite, verification, reset). Links point at the Hosted UI, and
 * only hashed single-use tokens are persisted. Without `SMTP_URL` the API still answers the
 * same, but no message is delivered.
 */
const mailer = createMailer(env);
const accountTokens = createPrismaAccountTokenStore(prisma);
const accountLifecycle = createAccountLifecycle({
  users: createPrismaLifecycleUserStore(prisma),
  tokens: accountTokens,
  mailer,
  links: { uiBaseUrl: env.HOSTED_UI_URL ?? env.APP_URL },
});
/** Shared fixed-window counters for the account endpoints (docs/security.md 3.2). */
const accountRateLimiter = createRedisRateLimiter(redis);

// Per-app social provider secrets are encrypted with AES-256-GCM. Production refuses to
// start without a valid SOCIAL_SECRET_KEY; development may run without one, in which case
// writes fail closed with 503 instead of persisting an unencrypted credential.
const socialSecretKey = loadSocialSecretKey(env);
const socialSecretBox = socialSecretKey === null ? null : createSecretBox(socialSecretKey);

/**
 * TOTP secrets are encrypted at rest with a dedicated AES-256-GCM key (`MFA_SECRET_KEY`,
 * falling back to the social key for single-key deployments). Without a key MFA enrollment
 * and verification answer `503` instead of persisting or accepting a plaintext secret.
 */
const mfaSecretKey = loadMfaSecretKey(env);
const mfaSecretBox = mfaSecretKey === null ? null : createSecretBox(mfaSecretKey);
const mfaRepository = createPrismaMfaRepository(prisma, { permissions: permissionReader });
const mfaDependencies = {
  repository: mfaRepository,
  challenges: new RedisMfaChallengeStore(redis),
  secretBox: mfaSecretBox,
  verify: verifyPassword,
};

/**
 * WebAuthn/passkey ceremonies. The RP ID and origin allowlist come from validated
 * configuration (`APP_URL` + `WEBAUTHN_ALLOWED_ORIGINS`); an invalid allowlist fails startup.
 * Passkeys are a second factor and a step-up proof, never a passwordless first factor.
 */
const webauthnDependencies = {
  config: resolveWebauthnConfig({
    appUrl: env.APP_URL,
    allowedOrigins: env.WEBAUTHN_ALLOWED_ORIGINS,
    rpName: new URL(env.APP_URL).host,
  }),
  challenges: new RedisWebauthnChallengeStore(redis),
  repository: mfaRepository,
  library: new SimpleWebauthnLibrary(),
};

/**
 * Per-app social login (`docs/auth-flows.md` 9): single-use transactions live in Redis so the
 * callback can be served by any API instance, and each callback only ever decrypts the
 * credential row of the client in its path.
 */
const socialTransactions = new RedisSocialTransactionStore(redis);
const socialLoginRepository = createPrismaSocialLoginRepository(prisma, {
  rbac: rbacRepository,
});
const socialAdapters = {
  google: new GoogleSocialAdapter(),
  facebook: new FacebookSocialAdapter(),
};
const authorizeLoginRequests = {
  create: (input: { clientId: string; authorizeUrl: string }) =>
    socialTransactions.createAuthorizeLoginRequest(input),
};

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

/**
 * `/oauth2/authorize` re-evaluates the MFA/step-up policy and membership server-side: the
 * password login endpoint only sees a caller-supplied `clientId`, so token issuance is the
 * only point that covers every session source (password, MFA, passkey, social).
 */
const authorizeAuthenticationRequirement = createAuthorizeAuthenticationRequirement(mfaRepository);
const authorizeMembershipStatus = createAuthorizeMembershipStatus(prisma);
/** Re-checks the context and membership when a context-bound code/refresh is exchanged. */
const loginContextAccess = createPrismaLoginContextAccessSource(prisma);

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
    contextAccess: loginContextAccess,
  },
  userInfo: { users: usersRepository, access: effectiveAccess },
  authorize: {
    clients: clientsRepository,
    loginUrl: `${(env.HOSTED_UI_URL ?? env.APP_URL).replace(/\/+$/, '')}/`,
    isClientAdminEligible,
    authenticationRequirement: authorizeAuthenticationRequirement,
    membershipStatus: authorizeMembershipStatus,
    loginRequests: authorizeLoginRequests,
  },
  social: {
    ...(env.SOCIAL_CALLBACK_BASE_URL === undefined
      ? {}
      : { callbackBaseUrl: env.SOCIAL_CALLBACK_BASE_URL }),
    loginUrl: `${(env.HOSTED_UI_URL ?? env.APP_URL).replace(/\/+$/, '')}/`,
    repository: socialLoginRepository,
    transactions: socialTransactions,
    ...(socialSecretBox === null ? {} : { secretBox: socialSecretBox }),
    adapters: socialAdapters,
    sessions,
    persistSession: (input) => loginRepository.persistSession(input),
    // Resolves the public client id to its UUID, because `audit_events.client_id` is a FK.
    audit: createPrismaAdminAudit(prisma),
    cookie: {
      secure: env.APP_URL.startsWith('https://'),
      idleTtlSeconds: env.SESSION_IDLE_TTL_SECONDS,
      absoluteTtlSeconds: env.SESSION_ABSOLUTE_TTL_SECONDS,
    },
  },
  login: {
    users: loginRepository,
    sessions,
    persistSession: (input) => loginRepository.persistSession(input),
    audit: { record: (event) => loginRepository.record(event) },
    mfa: mfaDependencies,
    webauthn: webauthnDependencies,
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
    audit: createPrismaAdminAudit(prisma),
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
  translations: {
    repository: publicTranslationsRepository,
    cache: translationBundleCache,
    allowedOrigins: (clientId) => clientsRepository.findAllowedOrigins(clientId),
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
  adminTranslations: {
    adminClientId: env.ADMIN_CLIENT_ID,
    permissions: permissionReader,
    translations: adminTranslationsRepository,
    audit: createPrismaAdminAudit(prisma),
    cache: translationBundleCache,
  },
  socialProviders: {
    adminClientId: env.ADMIN_CLIENT_ID,
    permissions: permissionReader,
    providers: createPrismaSocialProviderRepository(prisma),
    audit: createPrismaAdminAudit(prisma),
    secretBox: socialSecretBox,
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
    notifications: { sendInvite: (userId) => accountLifecycle.sendInvite(userId) },
    rateLimit: accountRateLimiter,
  },
  adminLoginContexts: {
    adminClientId: env.ADMIN_CLIENT_ID,
    permissions: permissionReader,
    contexts: createPrismaLoginContextRepository(prisma),
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
    repository: adminSessionsRepository,
    revoker: sessions,
    audit: createPrismaAdminAudit(prisma),
  },
  account: {
    sessions,
    repository: adminSessionsRepository,
    persistSession: (input) => loginRepository.persistSession(input),
    profiles: createPrismaAccountProfileRepository(prisma),
    passwords: passwordStore,
    audit: createPrismaAdminAudit(prisma),
    mfa: {
      repository: mfaRepository,
      secretBox: mfaSecretBox,
      issuer: new URL(env.APP_URL).host,
      verify: verifyPassword,
    },
    webauthn: webauthnDependencies,
  },
  adminKeys: {
    adminClientId: env.ADMIN_CLIENT_ID,
    permissions: permissionReader,
    audit: createPrismaAdminAudit(prisma),
  },
  accountLifecycle: {
    sessions,
    lifecycle: accountLifecycle,
    tokens: accountTokens,
    passwords: passwordStore,
    rateLimit: accountRateLimiter,
    audit: createPrismaAdminAudit(prisma),
  },
});

/**
 * Scheduled rotation (docs/architecture.md 5). `KEY_ROTATION_INTERVAL_DAYS=0` disables it;
 * the scheduler never starts in a test build, and index.ts is the only place that starts
 * a timer.
 */
const keyRotationAudit = createPrismaAdminAudit(prisma);
const keyRotationScheduler = new KeyRotationScheduler({
  keys,
  intervalDays: env.KEY_ROTATION_INTERVAL_DAYS,
  onRotated: async (result) => {
    await keyRotationAudit.record({
      actorType: 'system',
      action: 'key.rotate',
      targetType: 'signing_key',
      targetId: null,
      result: 'success',
      metadata: {
        kid: result.active.kid,
        previousKid: result.previousKid,
        previousRevoked: result.previousRevoked,
        trigger: 'scheduled',
      },
    });
    console.log(
      `signing key rotated: active=${result.active.kid} previous=${result.previousKid ?? 'none'}`,
    );
  },
  onError: (error) => {
    console.error(`signing key rotation failed: ${error.message}`);
  },
});
keyRotationScheduler.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    keyRotationScheduler.stop();
    void app
      .close()
      .then(() => prisma.$disconnect())
      .then(() => redis.quit())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
console.log(`on4net IDPN API listening on http://${env.HOST}:${env.PORT}`);
