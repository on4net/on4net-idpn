import type { FastifyInstance } from 'fastify';

import type { EffectiveAccessSource } from './effective-access.js';
import type { SigningKeyManager } from './keys.js';
import { buildUserInfo } from './userinfo.js';

export interface UserProfileSource {
  username: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  locale: string;
  avatarUrl: string | null;
  phone: string | null;
  phoneVerified: boolean;
}

export interface UserInfoRouteOptions {
  issuer: string;
  keys: SigningKeyManager;
  users: { findUserInfoProfile(userId: string): Promise<UserProfileSource | null> };
  /** Used only when the token says `permissions_source=userinfo`. */
  access?: EffectiveAccessSource;
}

/**
 * `GET /oauth2/userinfo` (docs/api.md 2.3).
 *
 * The bearer token must be one of our own ES256 access tokens. Claims are filtered by the
 * scopes inside the token, so a client never receives more than it was granted.
 */
export function registerUserInfoRoute(app: FastifyInstance, options: UserInfoRouteOptions): void {
  app.get('/oauth2/userinfo', async (request, reply) => {
    const header = request.headers.authorization;
    const match = header === undefined ? null : /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (match?.[1] === undefined) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer error="invalid_token"')
        .header('Cache-Control', 'no-store')
        .send({ error: 'invalid_token' });
    }

    let claims;
    try {
      claims = await options.keys.verify(match[1], { issuer: options.issuer });
    } catch {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer error="invalid_token"')
        .header('Cache-Control', 'no-store')
        .send({ error: 'invalid_token' });
    }

    const subject = claims.sub;
    if (subject === undefined) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer error="invalid_token"')
        .header('Cache-Control', 'no-store')
        .send({ error: 'invalid_token' });
    }

    const profile = await options.users.findUserInfoProfile(subject);
    if (profile === null) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer error="invalid_token"')
        .header('Cache-Control', 'no-store')
        .send({ error: 'invalid_token' });
    }

    const response = buildUserInfo(claims, profile);

    if (
      claims.permissions_source === 'userinfo' &&
      options.access !== undefined &&
      typeof claims.sub === 'string' &&
      typeof claims.client_id === 'string'
    ) {
      const access = await options.access.resolve({
        userId: claims.sub,
        clientId: claims.client_id,
        ...(typeof claims.login_context === 'string' ? { loginContext: claims.login_context } : {}),
      });
      response.roles = access.roles;
      response.permissions = access.permissions;
      if (access.membership !== null) {
        response.membership = access.membership;
      }
    }

    return reply.header('Cache-Control', 'no-store').send(response);
  });
}
