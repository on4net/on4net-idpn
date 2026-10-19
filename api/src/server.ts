import { healthResponseSchema, type HealthResponse } from '@idpn/contracts';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerFormBodyParser } from './http/form-body.js';
import type { AdminRoutesOptions } from './admin/routes.js';
import { registerAdminRoutes } from './admin/routes.js';
import type { ClientRoutesOptions } from './admin/clients/routes.js';
import { registerClientAdminRoutes } from './admin/clients/routes.js';
import type { RbacRoutesOptions } from './admin/rbac/routes.js';
import { registerRbacAdminRoutes } from './admin/rbac/routes.js';
import type { MemberRoutesOptions } from './admin/members/routes.js';
import { registerMemberAdminRoutes } from './admin/members/routes.js';
import { MemorySigningKeyRepository, SigningKeyManager } from './oidc/keys.js';
import { registerAuthorizeRoute } from './oidc/authorize-route.js';
import { registerOidcRoutes } from './oidc/routes.js';
import { registerRevokeIntrospectRoutes } from './oidc/revoke-introspect.js';
import { registerPublicConfigRoute } from './public-config/routes.js';
import type { LoginRouteOptions } from './login/routes.js';
import { registerLoginRoute } from './login/routes.js';
import type { TokenRouteOptions } from './oidc/token-route.js';
import { registerTokenRoute } from './oidc/token-route.js';
import { registerUserInfoRoute } from './oidc/userinfo-route.js';

export interface BuildServerOptions {
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
  userInfo?: { users: Parameters<typeof registerUserInfoRoute>[1]['users'] };
  login?: Omit<LoginRouteOptions, 'appUrl'>;
  /** Mounts GET /oauth2/authorize; requires a client repository and the code store. */
  authorize?: {
    clients: Parameters<typeof registerAuthorizeRoute>[1]['clients'];
    /** Hosted Auth UI used for interactive requests; defaults to `${issuer}/login`. */
    loginUrl?: string;
    isClientAdminEligible?: (userId: string, clientId: string) => Promise<boolean>;
  };
  /** Mounts the global Admin API user endpoints (docs/api.md 3). */
  admin?: Omit<AdminRoutesOptions, 'issuer' | 'verifier'>;
  /** Mounts the client administration endpoints (docs/api.md 3.3). */
  adminClients?: Omit<ClientRoutesOptions, 'issuer' | 'verifier'>;
  /** Mounts the permission catalog and role endpoints (docs/api.md 3.4). */
  rbac?: Omit<RbacRoutesOptions, 'issuer' | 'verifier'>;
  /** Mounts the client membership endpoints (docs/api.md 3.3.1). */
  adminMembers?: Omit<MemberRoutesOptions, 'issuer' | 'verifier'>;
}

/**
 * Builds the HTTP application. Operational, discovery and JWKS endpoints exist at this
 * stage; the remaining OIDC and Admin API routes are mounted here as they are implemented.
 */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const issuer = options.issuer ?? 'http://127.0.0.1:3000';
  const keys = options.keys ?? new SigningKeyManager(new MemorySigningKeyRepository());

  // RFC 6749/7009 clients post `application/x-www-form-urlencoded` to the token and
  // revocation endpoints; the JSON body stays supported for first-party callers.
  registerFormBodyParser(app);

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
      ...(options.token.now === undefined ? {} : { now: options.token.now }),
    });

    if (options.authorize !== undefined) {
      registerAuthorizeRoute(app, {
        issuer,
        clients: options.authorize.clients,
        codes: options.token.codes,
        sessions: options.token.sessions ?? { read: async () => null },
        ...(options.authorize.loginUrl === undefined
          ? {}
          : { loginUrl: options.authorize.loginUrl }),
        ...(options.authorize.isClientAdminEligible === undefined
          ? {}
          : { isClientAdminEligible: options.authorize.isClientAdminEligible }),
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

  if (options.userInfo !== undefined) {
    registerUserInfoRoute(app, { issuer, keys, users: options.userInfo.users });
  }

  if (options.login !== undefined) {
    registerLoginRoute(app, { ...options.login, appUrl: issuer });
  }

  if (options.admin !== undefined) {
    registerAdminRoutes(app, { ...options.admin, issuer, verifier: keys });
  }

  if (options.adminClients !== undefined) {
    registerClientAdminRoutes(app, { ...options.adminClients, issuer, verifier: keys });
  }

  if (options.rbac !== undefined) {
    registerRbacAdminRoutes(app, { ...options.rbac, issuer, verifier: keys });
  }

  if (options.adminMembers !== undefined) {
    registerMemberAdminRoutes(app, { ...options.adminMembers, issuer, verifier: keys });
  }

  return app;
}
