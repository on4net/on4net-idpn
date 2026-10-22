import type { FastifyInstance } from 'fastify';

import {
  buildOpenIdConfiguration,
  DISCOVERY_CACHE_CONTROL,
  JWKS_CACHE_CONTROL,
} from './discovery.js';
import type { SigningKeyManager } from './keys.js';

export interface OidcRoutesOptions {
  issuer: string;
  keys: SigningKeyManager;
}

/** Registers the public OIDC discovery and JWKS endpoints. */
export function registerOidcRoutes(app: FastifyInstance, options: OidcRoutesOptions): void {
  app.get('/.well-known/openid-configuration', async (_request, reply) => {
    return reply
      .header('Cache-Control', DISCOVERY_CACHE_CONTROL)
      .header('Content-Type', 'application/json')
      .send(buildOpenIdConfiguration({ issuer: options.issuer }));
  });

  app.get('/.well-known/jwks.json', async (_request, reply) => {
    const jwks = await options.keys.jwks();
    return reply
      .header('Cache-Control', JWKS_CACHE_CONTROL)
      .header('Content-Type', 'application/json')
      .send(jwks);
  });
}
