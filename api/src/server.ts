import { healthResponseSchema, type HealthResponse } from '@idpn/contracts';
import Fastify, { type FastifyInstance } from 'fastify';

import { MemorySigningKeyRepository, SigningKeyManager } from './oidc/keys.js';
import { registerOidcRoutes } from './oidc/routes.js';
import { registerRevokeIntrospectRoutes } from './oidc/revoke-introspect.js';
import type { TokenRouteOptions } from './oidc/token-route.js';
import { registerTokenRoute } from './oidc/token-route.js';

export interface BuildServerOptions {
  /** Public issuer URL; defaults to a local development value. */
  issuer?: string;
  keys?: SigningKeyManager;
  token?: Omit<TokenRouteOptions, 'issuer' | 'keys'>;
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
  }

  return app;
}
