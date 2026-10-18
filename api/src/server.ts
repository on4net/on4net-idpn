import { healthResponseSchema, type HealthResponse } from '@idpn/contracts';
import Fastify, { type FastifyInstance } from 'fastify';

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
  authorize?: { clients: Parameters<typeof registerAuthorizeRoute>[1]['clients'] };
}

/**
 * Builds the HTTP application. Operational, discovery and JWKS endpoints exist at this
 * stage; the remaining OIDC and Admin API routes are mounted here as they are implemented.
 */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const issuer = options.issuer ?? 'http://127.0.0.1:3000';
  const keys = options.keys ?? new SigningKeyManager(new MemorySigningKeyRepository());

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

  return app;
}
