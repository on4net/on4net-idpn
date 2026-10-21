import Fastify from 'fastify';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import type { EffectiveAccessSource } from '../src/oidc/effective-access.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { registerUserInfoRoute } from '../src/oidc/userinfo-route.js';

const issuer = 'https://auth.example.com';
const userId = 'user-1';

const profile = {
  username: 'ali',
  email: 'ali@example.com',
  emailVerified: true,
  displayName: 'Ali',
  locale: 'fa-IR',
  avatarUrl: null,
  phone: null,
  phoneVerified: false,
};

const access: EffectiveAccessSource = {
  async resolve() {
    return {
      roles: ['app-a:member'],
      permissions: ['app-a:contact:read'],
      membership: { context: null, status: 'active', attributes: { department: 'sales' } },
    };
  },
};

let keys: SigningKeyManager;

beforeAll(async () => {
  keys = new SigningKeyManager(new MemorySigningKeyRepository());
  await keys.ensureKey();
});

async function build(accessSource?: EffectiveAccessSource) {
  const app = Fastify({ logger: false });
  registerUserInfoRoute(app, {
    issuer,
    keys,
    users: {
      async findUserInfoProfile(id) {
        return id === userId ? profile : null;
      },
    },
    ...(accessSource === undefined ? {} : { access: accessSource }),
  });
  await app.ready();
  return app;
}

const token = (extra: Record<string, unknown> = {}, audience = 'app-a') =>
  keys.signAccessToken(
    {
      iss: issuer,
      sub: userId,
      aud: audience,
      client_id: 'app-a',
      // The real access-token builder always sets this (see `buildAccessTokenClaims`).
      token_use: 'access',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      scope: 'openid profile',
      ...extra,
    },
    { issuer, audience, subject: userId, expiresInSeconds: 300 },
  );

describe('GET /oauth2/userinfo token binding', () => {
  it('rejects an ID token, which carries no token_use', async () => {
    const app = await build();
    await request(app.server)
      .get('/oauth2/userinfo')
      .set('Authorization', 'Bearer ' + (await token({ token_use: undefined })))
      .expect(401);
    await app.close();
  });

  it('rejects a token whose audience is another client', async () => {
    const app = await build();
    await request(app.server)
      .get('/oauth2/userinfo')
      .set('Authorization', 'Bearer ' + (await token({}, 'app-b')))
      .expect(401);
    await app.close();
  });
});

describe('GET /oauth2/userinfo role fallback', () => {
  it('adds roles and permissions when the token points to userinfo', async () => {
    const app = await build(access);
    const response = await request(app.server)
      .get('/oauth2/userinfo')
      .set('Authorization', 'Bearer ' + (await token({ permissions_source: 'userinfo' })))
      .expect(200);

    expect(response.body).toMatchObject({
      sub: userId,
      roles: ['app-a:member'],
      permissions: ['app-a:contact:read'],
      membership: { context: null, status: 'active', attributes: { department: 'sales' } },
    });
    await app.close();
  });

  it('does not add role claims for a regular token', async () => {
    const app = await build(access);
    const response = await request(app.server)
      .get('/oauth2/userinfo')
      .set('Authorization', 'Bearer ' + (await token()))
      .expect(200);
    expect(response.body).not.toHaveProperty('roles');
    expect(response.body).not.toHaveProperty('permissions');
    await app.close();
  });

  it('stays backward compatible when no access source is wired', async () => {
    const app = await build();
    const response = await request(app.server)
      .get('/oauth2/userinfo')
      .set('Authorization', 'Bearer ' + (await token({ permissions_source: 'userinfo' })))
      .expect(200);
    expect(response.body).not.toHaveProperty('roles');
    await app.close();
  });
});
