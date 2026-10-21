import { PrismaPg } from '@prisma/adapter-pg';
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';

import { createPrismaAccountProfileRepository } from './account/prisma-account-repository.js';
import { createAccountLifecycle } from './account/lifecycle.js';
import { createPrismaLifecycleUserStore } from './account/prisma-lifecycle-repository.js';
import { createPrismaAccountTokenStore } from './account/prisma-token-repository.js';
import { createMailer } from './mail/index.js';
import { createRedisRateLimiter } from './http/rate-limit.js';
import { loadApiEnv } from './config/env.js';
import { createClientSecretService, loadClientSecretPeppers } from './auth/client-secret.js';
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
  BackchannelLogoutQueueDrainer,
  BACKCHANNEL_LOGOUT_QUEUE_KEY,
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
import { createPrismaContextSwitchRepository } from './login/context-switch.js';
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
import { hashPassword, verifyPassword } from './auth/password.js';
import { argon2ParamsFromEnv } from './auth/password-config.js';
import { buildServer } from './server.js';
import { readBackupStatus } from './observability/backup-status.js';
import { DependencyMonitor } from './observability/health.js';
import { sanitizeLogMessage } from './observability/logging.js';
import { ApiMetrics } from './observability/metrics.js';
import { createPrismaSessionRevocationHook } from './session/prisma-revocation.js';
import { createPrismaSessionSlideMirror } from './session/prisma-slide.js';
import { RedisSessionCache } from './session/redis-cache.js';
import { RedisSessionStore } from './session/store.js';

const env = loadApiEnv();

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });

/**
 * Operational metrics and readiness (docs/monitoring.md). Metrics are in-process counters;
 * the expensive gauges (dependency probes, session count, key age, queue depth) are only
 * collected during a scrape so request handling stays unaffected.
 */
const metrics = new ApiMetrics();
const dependencyMonitor = new DependencyMonitor({
  probes: [
    {
      name: 'postgres',
      check: async () => {
        await prisma.$queryRaw`SELECT 1`;
      },
    },
    {
      name: 'redis',
      check: async () => {
        const reply = await redis.ping();
        if (reply !== 'PONG') {
          throw new Error(`unexpected PING reply: ${reply}`);
        }
      },
    },
  ],
});

/**
 * Startup code (signing keys, back-channel queue) runs before the Fastify logger exists, so
 * these helpers buffer on the console until `appLogger` is assigned and are structured
 * afterwards. Neither helper receives token or secret material.
 */
const loggerRef: { current?: FastifyBaseLogger } = {};
const logWarning = (context: Record<string, unknown>, message: string): void => {
  if (loggerRef.current === undefined) {
    console.warn(message);
    return;
  }
  loggerRef.current.warn(context, message);
};
const logError = (context: Record<string, unknown>, message: string): void => {
  if (loggerRef.current === undefined) {
    console.error(message);
    return;
  }
  loggerRef.current.error(context, message);
};

// Without a listener ioredis prints "Unhandled error event" for every reconnect attempt.
// A structured, sanitized line keeps a Redis outage visible without flooding plain text.
redis.on('error', (error: unknown) => {
  logError({ component: 'redis' }, `redis error: ${sanitizeLogMessage(error)}`);
});

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
    keyCacheTtlSeconds: env.KEY_CACHE_TTL_SECONDS,
    onWarning: (message) => logWarning({ component: 'signing-key' }, message),
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
  // The idle slide is write-behind so the admin list and the active-session gauge see the
  // real expiry instead of the creation-time one (throttled per sid inside the store).
  onSlide: createPrismaSessionSlideMirror(prisma),
});

const clientsRepository = createPrismaClientRepository(prisma);
/**
 * Client secrets are stored as a keyed HMAC-SHA-256 (`docs/client-secret-hashing.md`), not
 * Argon2id: they are 256-bit machine-generated values, so a memory-hard hash only made every
 * `/token` request pay ~120ms. Production refuses to start without `CLIENT_SECRET_PEPPER`;
 * the public pepper id supports rotation while previous peppers keep verifying.
 */
const clientSecrets = createClientSecretService(loadClientSecretPeppers(env));
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
/** Shared fixed-window counters for the account and credential endpoints (docs/security.md 3.2). */
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
  onDelivery: (delivery) => metrics.recordBackchannelDelivery(delivery.status),
  onError: (error, context) => {
    // Never log token material, only the client, the phase and a sanitized reason.
    logError(
      { component: 'backchannel-logout', clientId: context.clientId, phase: context.phase },
      `back-channel logout failed: ${sanitizeLogMessage(error)}`,
    );
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
const authorizationCodes = createPrismaCodeRepository(prisma);
/**
 * One hashing policy for every credential: login, password change/reset, admin-created
 * passwords and MFA recovery codes. `PASSWORD_PEPPER` is applied as the Argon2 secret and is
 * never stored (card #70 finding 4).
 */
const passwordParams = argon2ParamsFromEnv(env);

const app = buildServer({
  issuer: env.APP_URL,
  keys,
  logLevel: env.LOG_LEVEL,
  // Only a peer inside these ranges may set X-Forwarded-For; without it every client behind
  // the reference Caddy shares one per-IP rate-limit bucket (docs/security.md 4).
  trustProxy: env.TRUSTED_PROXY_CIDRS.length > 0 ? env.TRUSTED_PROXY_CIDRS : false,
  readiness: dependencyMonitor,
  ...(env.METRICS_ENABLED
    ? {
        metrics: {
          metrics,
          collect: collectGaugeMetrics,
          ...(env.METRICS_TOKEN === undefined ? {} : { token: env.METRICS_TOKEN }),
        },
      }
    : {}),
  token: {
    clients: clientsRepository,
    clientSecrets,
    codes: authorizationCodes,
    refreshTokens: createPrismaRefreshTokenRepository(prisma),
    users: usersRepository,
    sessions,
    isClientAdminEligible,
    access: effectiveAccess,
    contextAccess: loginContextAccess,
    metrics,
    audit: createPrismaAdminAudit(prisma),
  },
  userInfo: { users: usersRepository, access: effectiveAccess },
  authorize: {
    clients: clientsRepository,
    loginUrl: `${(env.HOSTED_UI_URL ?? env.APP_URL).replace(/\/+$/, '')}/`,
    isClientAdminEligible,
    authenticationRequirement: authorizeAuthenticationRequirement,
    membershipStatus: authorizeMembershipStatus,
    loginRequests: authorizeLoginRequests,
    audit: createPrismaAdminAudit(prisma),
    persistContextSwitch: async (sid, loginContext) => {
      await adminSessionsRepository.updateLoginContext?.(sid, loginContext);
    },
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
    rateLimiter: accountRateLimiter,
    passwordParams,
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
    hashPassword: (plain: string) => hashPassword(plain, passwordParams),
  },
  adminClients: {
    adminClientId: env.ADMIN_CLIENT_ID,
    permissions: permissionReader,
    clients: createPrismaAdminClientRepository(prisma),
    clientSecrets,
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
    passwordParams,
    mfa: {
      repository: mfaRepository,
      secretBox: mfaSecretBox,
      issuer: new URL(env.APP_URL).host,
      verify: verifyPassword,
      recoveryParams: passwordParams,
    },
    webauthn: webauthnDependencies,
    // Context switching is decided from the context status, the membership and the
    // authentication the session already proves (`docs/login-contexts.md` 4.1, 6).
    contextSwitch: {
      repository: createPrismaContextSwitchRepository(prisma),
      isAdmin: (userId, clientId) => mfaRepository.isAdmin(userId, clientId),
    },
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
    passwordParams,
  },
});

loggerRef.current = app.log;

/**
 * Gauge collection for `/metrics`. Each source is isolated: one failing collector increments
 * `idpn_metrics_collector_errors_total` and leaves the other gauges intact, so a degraded
 * database does not blank the whole dashboard.
 */
async function collectGaugeMetrics(): Promise<void> {
  const readiness = await dependencyMonitor.check();
  for (const check of readiness.checks) {
    metrics.dependencyUp.set({ service: check.name }, check.status === 'ok' ? 1 : 0);
  }

  try {
    const health = await keys.inspect();
    if (health.activeKey !== null) {
      metrics.signingKeyAgeDays.set({}, health.activeKey.ageDays);
    }
    metrics.signingKeyRotationDue.set({}, health.rotationDue ? 1 : 0);
  } catch (error) {
    metrics.recordCollectorError('signing_key');
    logWarning(
      { component: 'metrics', collector: 'signing_key', error: sanitizeLogMessage(error) },
      'collector failed',
    );
  }

  try {
    const at = new Date();
    const active = await prisma.session.count({
      where: { revokedAt: null, idleExpiresAt: { gt: at }, absoluteExpiresAt: { gt: at } },
    });
    metrics.activeSessions.set({}, active);
  } catch (error) {
    metrics.recordCollectorError('active_sessions');
    logWarning(
      { component: 'metrics', collector: 'active_sessions', error: sanitizeLogMessage(error) },
      'collector failed',
    );
  }

  try {
    metrics.backchannelQueueDepth.set({}, await redis.llen(BACKCHANNEL_LOGOUT_QUEUE_KEY));
  } catch (error) {
    metrics.recordCollectorError('backchannel_queue');
    logWarning(
      { component: 'metrics', collector: 'backchannel_queue', error: sanitizeLogMessage(error) },
      'collector failed',
    );
  }

  try {
    const backup = await readBackupStatus(env.BACKUP_STATUS_FILE);
    if (backup !== null) {
      metrics.backupLastSuccess.set({}, Math.floor(backup.lastSuccessAt.getTime() / 1000));
    }
  } catch (error) {
    metrics.recordCollectorError('backup_status');
    logWarning(
      { component: 'metrics', collector: 'backup_status', error: sanitizeLogMessage(error) },
      'collector failed',
    );
  }
}

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
    app.log.info(
      { component: 'signing-key', kid: result.active.kid, previousKid: result.previousKid },
      'signing key rotated',
    );
  },
  onError: (error) => {
    logError(
      { component: 'signing-key' },
      `signing key rotation failed: ${sanitizeLogMessage(error)}`,
    );
  },
});
keyRotationScheduler.start();

/**
 * Drains the durable back-channel logout queue (docs/auth-flows.md 6.3). The worker issues a
 * fresh Logout Token per attempt, keeps in-flight entries in a separate list so a crash does
 * not lose them, and dead-letters an entry after `maxAttempts`.
 */
const backchannelQueueDrainer = new BackchannelLogoutQueueDrainer({
  redis,
  tokens: new LogoutTokenSigner({
    issuer: env.APP_URL,
    keys,
    registry: new RedisLogoutTokenJtiRegistry(redis),
  }),
  sender: new FetchBackchannelLogoutSender(),
  onDelivery: (delivery) => metrics.recordBackchannelDelivery(delivery.status),
  onError: (error, context) => {
    logError(
      { component: 'backchannel-logout', clientId: context.clientId, phase: context.phase },
      `back-channel logout retry failed: ${sanitizeLogMessage(error)}`,
    );
  },
});
const backchannelQueueTimer = setInterval(() => {
  void backchannelQueueDrainer.drainOnce().catch((error: unknown) => {
    logWarning(
      { component: 'backchannel-logout', phase: 'drain' },
      `queue drain failed: ${sanitizeLogMessage(error)}`,
    );
  });
}, 15_000);
backchannelQueueTimer.unref();

/**
 * Retention for account lifecycle tokens: consumed and long-expired invite/verification/reset
 * rows are deleted hourly, so the table keeps the `expires_at` index meaningful instead of
 * growing forever (docs/domain-model.md 4).
 */
const accountTokenPurgeTimer = setInterval(() => {
  void accountTokens.purge({ now: new Date() }).catch((error: unknown) => {
    logWarning(
      { component: 'account-tokens', phase: 'purge' },
      `token purge failed: ${sanitizeLogMessage(error)}`,
    );
  });
}, 60 * 60 * 1000);
accountTokenPurgeTimer.unref();

/**
 * Authorization codes live for a minute; expired rows are deleted hourly so the table does
 * not grow without bound and every lookup stays an index hit (card #70 finding 14).
 */
const authorizationCodePurgeTimer = setInterval(
  () => {
    void authorizationCodes.purgeExpired?.(new Date()).catch((error: unknown) => {
      logWarning(
        { component: 'authorization-codes', phase: 'purge' },
        `code purge failed: ${sanitizeLogMessage(error)}`,
      );
    });
  },
  60 * 60 * 1000,
);
authorizationCodePurgeTimer.unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    keyRotationScheduler.stop();
    clearInterval(backchannelQueueTimer);
    clearInterval(accountTokenPurgeTimer);
    clearInterval(authorizationCodePurgeTimer);
    void app
      .close()
      .then(() => prisma.$disconnect())
      .then(() => redis.quit())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
app.log.info(
  {
    host: env.HOST,
    port: env.PORT,
    metrics: env.METRICS_ENABLED,
    readiness: true,
  },
  'on4net IDPN API listening',
);
