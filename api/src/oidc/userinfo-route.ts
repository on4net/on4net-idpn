import type { FastifyInstance } from 'fastify';

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

    return reply.header('Cache-Control', 'no-store').send(buildUserInfo(claims, profile));
  });
}
