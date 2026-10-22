import { randomUUID } from 'node:crypto';

import { healthResponseSchema, type HealthResponse } from '@idpn/contracts';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AccountRoutesOptions } from './account/routes.js';
import { registerAccountRoutes } from './account/routes.js';
import type { AccountLifecycleRoutesOptions } from './account/lifecycle-routes.js';
import { registerAccountLifecycleRoutes } from './account/lifecycle-routes.js';
import { registerFormBodyParser } from './http/form-body.js';
import type { AdminRoutesOptions } from './admin/routes.js';
import { registerAdminRoutes } from './admin/routes.js';
import type { AuditRoutesOptions } from './admin/audit/routes.js';
import { registerAuditAdminRoutes } from './admin/audit/routes.js';
import type { ClientRoutesOptions } from './admin/clients/routes.js';
import { registerClientAdminRoutes } from './admin/clients/routes.js';
import type { TranslationAdminRoutesOptions } from './admin/translations/routes.js';
import { registerTranslationAdminRoutes } from './admin/translations/routes.js';
import type { SocialProviderRoutesOptions } from './admin/social-providers/routes.js';
import { registerSocialProviderAdminRoutes } from './admin/social-providers/routes.js';
import type { RbacRoutesOptions } from './admin/rbac/routes.js';
import { registerRbacAdminRoutes } from './admin/rbac/routes.js';
import type { MemberRoutesOptions } from './admin/members/routes.js';
import { registerMemberAdminRoutes } from './admin/members/routes.js';
import type { LoginContextRoutesOptions } from './admin/login-contexts/routes.js';
import { registerLoginContextAdminRoutes } from './admin/login-contexts/routes.js';
import type { SessionRoutesOptions } from './admin/sessions/routes.js';
import { registerSessionAdminRoutes } from './admin/sessions/routes.js';
import type { KeyRoutesOptions } from './admin/keys/routes.js';
import { registerKeyAdminRoutes } from './admin/keys/routes.js';
import { MemorySigningKeyRepository, SigningKeyManager } from './oidc/keys.js';
import { registerAuthorizeRoute } from './oidc/authorize-route.js';
import type { LogoutRouteOptions } from './oidc/logout-route.js';
import { registerLogoutRoute } from './oidc/logout-route.js';
import { registerOidcRoutes } from './oidc/routes.js';
import { registerRevokeIntrospectRoutes } from './oidc/revoke-introspect.js';
import { registerPublicConfigRoute } from './public-config/routes.js';
import type { TranslationBundleRouteOptions } from './translations/routes.js';
import { registerTranslationBundleRoute } from './translations/routes.js';
import type { LoginRouteOptions } from './login/routes.js';
import { registerLoginRoute } from './login/routes.js';
import { registerMfaVerifyRoute } from './login/mfa-routes.js';
import { registerLoginWebauthnRoutes } from './login/webauthn-routes.js';
import type { SocialLoginRouteOptions } from './social/routes.js';
import { registerSocialLoginRoutes } from './social/routes.js';
import type { TokenRouteOptions } from './oidc/token-route.js';
import { registerTokenRoute } from './oidc/token-route.js';
import { registerUserInfoRoute } from './oidc/userinfo-route.js';
import type { DependencyMonitor } from './observability/health.js';
import { sanitizeRequestId, buildLoggerOptions } from './observability/logging.js';
import {
  registerHttpMetrics,
  registerMetricsRoute,
  registerReadinessRoute,
  type MetricsRouteOptions,
} from './observability/routes.js';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface BuildServerOptions {
  /** Structured JSON logging level; omitted keeps the logger disabled (tests stay quiet). */
  logLevel?: LogLevel;
  /** Mounts `GET /metrics` (docs/monitoring.md); opt-in and internal-only. */
  metrics?: MetricsRouteOptions;
  /** Mounts `GET /readyz` with the given dependency probes. */
  readiness?: DependencyMonitor;
  /** Public issuer URL; defaults to a local development value. */
  issuer?: string;
  keys?: SigningKeyManager;
  token?: Omit<TokenRouteOptions, 'issuer' | 'keys'>;
  publicConfig?: {
    repository: Parameters<typeof registerPublicConfigRoute>[1]['repository'];
    originLookup: (clientId: string) => Promise<string[]>;
    mfe: { version: string; remoteEntry: string };
    translationsUrlTemplate?: string;
  };
  /** Mounts the public translation bundle (docs/api.md 3.3.4). */
  translations?: TranslationBundleRouteOptions;
  userInfo?: {
    users: Parameters<typeof registerUserInfoRoute>[1]['users'];
    access?: Parameters<typeof registerUserInfoRoute>[1]['access'];
    denyList?: Parameters<typeof registerUserInfoRoute>[1]['denyList'];
  };
  login?: Omit<LoginRouteOptions, 'appUrl'>;
  /** Mounts GET/POST /oauth2/logout (RP-initiated + back-channel). */
  logout?: Omit<LogoutRouteOptions, 'issuer' | 'keys'>;
  /** Mounts GET /oauth2/authorize; requires a client repository and the code store. */
  authorize?: {
    clients: Parameters<typeof registerAuthorizeRoute>[1]['clients'];
    /** Hosted Auth UI used for interactive requests; defaults to `${issuer}/login`. */
    loginUrl?: string;
    isClientAdminEligible?: (userId: string, clientId: string) => Promise<boolean>;
    /** Consent gate; defaults to granted for first-party clients. */
    isConsentGranted?: Parameters<typeof registerAuthorizeRoute>[1]['isConsentGranted'];
    /** Server-side MFA/step-up policy check before a code is issued. */
    authenticationRequirement?: Parameters<
      typeof registerAuthorizeRoute
    >[1]['authenticationRequirement'];
    /** Membership lookup for the client/login context (CTX-003). */
    membershipStatus?: Parameters<typeof registerAuthorizeRoute>[1]['membershipStatus'];
    /** Issues the opaque `login_request` used by the per-client social start endpoint. */
    loginRequests?: Parameters<typeof registerAuthorizeRoute>[1]['loginRequests'];
    /** Audit hook for an audited context switch at code issuance. */
    audit?: Parameters<typeof registerAuthorizeRoute>[1]['audit'];
    /** Mirrors a context switch into the PostgreSQL session row. */
    persistContextSwitch?: Parameters<typeof registerAuthorizeRoute>[1]['persistContextSwitch'];
  };
  /** Mounts the per-client social start/callback endpoints (docs/api.md 2.8). */
  social?: Omit<SocialLoginRouteOptions, 'issuer'>;
  /** Mounts the global Admin API user endpoints (docs/api.md 3). */
  admin?: Omit<AdminRoutesOptions, 'issuer' | 'verifier'>;
  /** Mounts the client administration endpoints (docs/api.md 3.3). */
  adminClients?: Omit<ClientRoutesOptions, 'issuer' | 'verifier'>;
  /** Mounts per-client locale and translation endpoints (docs/api.md 3.3.4). */
  adminTranslations?: Omit<TranslationAdminRoutesOptions, 'issuer' | 'verifier'>;
  /** Mounts per-app social provider credentials (docs/api.md 3.3.2). */
  socialProviders?: Omit<SocialProviderRoutesOptions, 'issuer' | 'verifier'>;
  /** Mounts the permission catalog and role endpoints (docs/api.md 3.4). */
  rbac?: Omit<RbacRoutesOptions, 'issuer' | 'verifier'>;
  /** Mounts the client membership endpoints (docs/api.md 3.3.1). */
  adminMembers?: Omit<MemberRoutesOptions, 'issuer' | 'verifier'>;
  /** Mounts the per-app login context endpoints (docs/api.md 3.3.3). */
  adminLoginContexts?: Omit<LoginContextRoutesOptions, 'issuer' | 'verifier'>;
  /** Mounts the audit read and export endpoints (docs/api.md 3.8). */
  audit?: Omit<AuditRoutesOptions, 'issuer' | 'verifier'>;
  /** Mounts session administration and self-service endpoints (docs/api.md 3.1, 3.7). */
  adminSessions?: Omit<SessionRoutesOptions, 'issuer' | 'verifier'>;
  /** Mounts the signing-key endpoints (docs/api.md 3.9). */
  adminKeys?: Omit<KeyRoutesOptions, 'issuer' | 'verifier' | 'keys'>;
  /** Mounts the same-origin account surface used by the embedded MFE (docs/account-api.md). */
  account?: Omit<AccountRoutesOptions, 'appUrl'>;
  /** Mounts invite acceptance, email verification and password reset (docs/auth-flows.md 8). */
  accountLifecycle?: Omit<AccountLifecycleRoutesOptions, 'appUrl'>;
  /**
   * Reverse proxies whose `X-Forwarded-For` may be trusted (CIDR list). `request.ip` is the
   * proxy address without it, so every per-IP limit would share one bucket.
   */
  trustProxy?: boolean | string | string[];
}

/**
 * Builds the HTTP application. Operational, discovery and JWKS endpoints exist at this
 * stage; the remaining OIDC and Admin API routes are mounted here as they are implemented.
 */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logLevel === undefined ? false : buildLoggerOptions(options.logLevel),
    genReqId: (request) => sanitizeRequestId(request.headers['x-request-id']) ?? randomUUID(),
    // Behind the reference reverse proxy every request shares the proxy's address unless the
    // trusted CIDRs are declared, which collapses every per-IP rate-limit bucket into one and
    // makes the audited `ip` useless (docs/security.md 4). Only a peer inside the configured
    // ranges may set `X-Forwarded-For`.
    trustProxy: options.trustProxy ?? false,
  });
  const issuer = options.issuer ?? 'http://127.0.0.1:6000';
  const keys = options.keys ?? new SigningKeyManager(new MemorySigningKeyRepository());

  // RFC 6749/7009 clients post `application/x-www-form-urlencoded` to the token and
  // revocation endpoints; the JSON body stays supported for first-party callers.
  registerFormBodyParser(app);

  if (options.metrics !== undefined) {
    registerHttpMetrics(app, { metrics: options.metrics.metrics });
    registerMetricsRoute(app, options.metrics);
  }
  if (options.readiness !== undefined) {
    registerReadinessRoute(app, options.readiness);
  }

  // Baseline response hardening: no content sniffing and no referrer leakage. The Hosted UI
  // sets its own CSP/HSTS at the edge (`docs/security.md` 12); these headers are safe for
  // JSON and redirect responses alike.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Request-Id', request.id);
    // Everything under /api and /oauth2 carries identity, secrets or token material, so no
    // intermediate cache or browser may store it. Routes that already chose a value keep it.
    if (
      reply.getHeader('Cache-Control') === undefined &&
      (request.url.startsWith('/api/') || request.url.startsWith('/oauth2/'))
    ) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  app.get('/healthz', async (_request, reply) => {
    const payload: HealthResponse = { status: 'ok', service: 'on4net-idpn-api' };
    return reply.header('Cache-Control', 'no-store').send(healthResponseSchema.parse(payload));
  });

  registerOidcRoutes(app, { issuer, keys });

  if (options.token !== undefined) {
    registerTokenRoute(app, { ...options.token, issuer, keys });
    registerRevokeIntrospectRoutes(app, {
      issuer,
      keys,
      clients: options.token.clients,
      refreshTokens: options.token.refreshTokens,
      ...(options.token.clientSecrets === undefined
        ? {}
        : { clientSecrets: options.token.clientSecrets }),
      ...(options.token.sessions === undefined ? {} : { sessions: options.token.sessions }),
      ...(options.userInfo?.denyList === undefined
        ? {}
        : { denyList: options.userInfo.denyList }),
      ...(options.token.now === undefined ? {} : { now: options.token.now }),
    });

    if (options.authorize !== undefined) {
      registerAuthorizeRoute(app, {
        issuer,
        clients: options.authorize.clients,
        codes: options.token.codes,
        sessions: options.token.sessions ?? { read: async () => null },
        ...(options.token.now === undefined ? {} : { now: options.token.now }),
        ...(options.authorize.loginUrl === undefined
          ? {}
          : { loginUrl: options.authorize.loginUrl }),
        ...(options.authorize.isClientAdminEligible === undefined
          ? {}
          : { isClientAdminEligible: options.authorize.isClientAdminEligible }),
        ...(options.authorize.isConsentGranted === undefined
          ? {}
          : { isConsentGranted: options.authorize.isConsentGranted }),
        // Without these two the server would validate a context key but never enforce the
        // MFA/step-up policy or the context membership at code issuance.
        ...(options.authorize.authenticationRequirement === undefined
          ? {}
          : { authenticationRequirement: options.authorize.authenticationRequirement }),
        ...(options.authorize.membershipStatus === undefined
          ? {}
          : { membershipStatus: options.authorize.membershipStatus }),
        ...(options.authorize.loginRequests === undefined
          ? {}
          : { loginRequests: options.authorize.loginRequests }),
        ...(options.authorize.audit === undefined ? {} : { audit: options.authorize.audit }),
        ...(options.authorize.persistContextSwitch === undefined
          ? {}
          : { persistContextSwitch: options.authorize.persistContextSwitch }),
      });
    }
  }

  if (options.publicConfig !== undefined) {
    registerPublicConfigRoute(app, {
      repository: options.publicConfig.repository,
      allowedOrigins: options.publicConfig.originLookup,
      dependencies: {
        mfe: options.publicConfig.mfe,
        ...(options.publicConfig.translationsUrlTemplate === undefined
          ? {}
          : { translationsUrlTemplate: options.publicConfig.translationsUrlTemplate }),
      },
    });
  }

  if (options.translations !== undefined) {
    registerTranslationBundleRoute(app, options.translations);
  }

  if (options.userInfo !== undefined) {
    registerUserInfoRoute(app, {
      issuer,
      keys,
      users: options.userInfo.users,
      ...(options.userInfo.access === undefined ? {} : { access: options.userInfo.access }),
      ...(options.userInfo.denyList === undefined
        ? {}
        : { denyList: options.userInfo.denyList }),
    });
  }

  if (options.login !== undefined) {
    registerLoginRoute(app, { ...options.login, appUrl: issuer });
    if (options.login.mfa !== undefined) {
      registerMfaVerifyRoute(app, {
        mfa: options.login.mfa,
        users: options.login.users,
        sessions: options.login.sessions,
        persistSession: options.login.persistSession,
        audit: options.login.audit,
        cookie: options.login.cookie,
        ...(options.login.rateLimiter === undefined
          ? {}
          : { rateLimiter: options.login.rateLimiter }),
        ...(options.login.alerts === undefined ? {} : { alerts: options.login.alerts }),
        ...(options.login.now === undefined ? {} : { now: options.login.now }),
      });
      if (options.login.webauthn !== undefined) {
        registerLoginWebauthnRoutes(app, {
          mfa: options.login.mfa,
          webauthn: options.login.webauthn,
          users: options.login.users,
          sessions: options.login.sessions,
          persistSession: options.login.persistSession,
          audit: options.login.audit,
          cookie: options.login.cookie,
          ...(options.login.rateLimiter === undefined
            ? {}
            : { rateLimiter: options.login.rateLimiter }),
          ...(options.login.alerts === undefined ? {} : { alerts: options.login.alerts }),
          ...(options.login.now === undefined ? {} : { now: options.login.now }),
        });
      }
    }
  }

  if (options.social !== undefined) {
    registerSocialLoginRoutes(app, { ...options.social, issuer });
  }

  if (options.logout !== undefined) {
    registerLogoutRoute(app, { ...options.logout, issuer, keys });
  }

  if (options.admin !== undefined) {
    registerAdminRoutes(app, { ...options.admin, issuer, verifier: keys });
  }

  if (options.adminClients !== undefined) {
    registerClientAdminRoutes(app, { ...options.adminClients, issuer, verifier: keys });
  }

  if (options.adminTranslations !== undefined) {
    registerTranslationAdminRoutes(app, {
      ...options.adminTranslations,
      issuer,
      verifier: keys,
    });
  }

  if (options.socialProviders !== undefined) {
    registerSocialProviderAdminRoutes(app, {
      ...options.socialProviders,
      issuer,
      verifier: keys,
    });
  }

  if (options.rbac !== undefined) {
    registerRbacAdminRoutes(app, { ...options.rbac, issuer, verifier: keys });
  }

  if (options.adminMembers !== undefined) {
    registerMemberAdminRoutes(app, { ...options.adminMembers, issuer, verifier: keys });
  }

  if (options.adminLoginContexts !== undefined) {
    registerLoginContextAdminRoutes(app, {
      ...options.adminLoginContexts,
      issuer,
      verifier: keys,
    });
  }

  if (options.audit !== undefined) {
    registerAuditAdminRoutes(app, { ...options.audit, issuer, verifier: keys });
  }

  if (options.adminSessions !== undefined) {
    registerSessionAdminRoutes(app, { ...options.adminSessions, issuer, verifier: keys });
  }

  if (options.adminKeys !== undefined) {
    registerKeyAdminRoutes(app, {
      ...options.adminKeys,
      issuer,
      verifier: keys,
      keys,
    });
  }

  if (options.account !== undefined) {
    registerAccountRoutes(app, { ...options.account, appUrl: issuer });
  }

  if (options.accountLifecycle !== undefined) {
    registerAccountLifecycleRoutes(app, { ...options.accountLifecycle, appUrl: issuer });
  }

  return app;
}
