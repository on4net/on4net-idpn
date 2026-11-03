import Fastify, { type FastifyInstance } from 'fastify';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { registerUserInfoRoute } from '../src/oidc/userinfo-route.js';
import { buildPublicClientConfig, type PublicClientSource } from '../src/public-config/build.js';
import { registerPublicConfigRoute } from '../src/public-config/routes.js';

const issuer = 'https://auth.example.com';

const source: PublicClientSource = {
  clientId: 'app-a',
  name: 'App A',
  status: 'active',
  locales: { default: 'fa-IR', supported: ['fa-IR'] },
  branding: { primaryColor: '#123456' },
  registrationPolicy: 'invite_only',
  mfaPolicy: 'optional',
  defaultLoginContextKey: null,
  mfeFeatures: { userManagement: true },
  loginContexts: [],
  socialProviders: [],
};

const deps = {
  mfe: { version: '1.0.0', remoteEntry: 'https://cdn.example.com/1.0.0/remoteEntry.js' },
};

function publicApp(overrides: { clock?: () => number } = {}) {
  const app: FastifyInstance = Fastify({ logger: false });
  registerPublicConfigRoute(app, {
    repository: {
      async findPublicClient(clientId) {
        return clientId === 'app-a' ? source : null;
      },
    },
    allowedOrigins: async () => ['https://app-a.example.com'],
    dependencies: deps,
    now: overrides.clock ?? (() => Date.now()),
  });
  return app;
}

describe('GET /api/v1/clients/:clientId/public-config', () => {
  it('serves the contract-valid configuration with cache headers and an ETag', async () => {
    const app = publicApp();
    await app.ready();

    const response = await request(app.server)
      .get('/api/v1/clients/app-a/public-config')
      .set('Origin', 'https://app-a.example.com')
      .expect(200);

    expect(response.headers['cache-control']).toBe('public, max-age=60');
    expect(response.headers.etag).toBeDefined();
    expect(response.headers['access-control-allow-origin']).toBe('https://app-a.example.com');
    expect(response.body).toEqual(buildPublicClientConfig(source, deps));
    expect(JSON.stringify(response.body)).not.toContain('redirect');

    const etag = String(response.headers.etag);
    await request(app.server)
      .get('/api/v1/clients/app-a/public-config')
      .set('If-None-Match', etag)
      .expect(304);

    await app.close();
  });

  it('serves only sanitized theme tokens', async () => {
    const hostile: PublicClientSource = {
      ...source,
      branding: {
        theme: {
          primary: 'url(javascript:alert(1))',
          background: '#ffffff',
          radius: '8px; color: red',
          extra: '#123456',
          dark: { foreground: 'expression(alert(1))', ring: '#abcdef' },
        },
      },
    };
    const app: FastifyInstance = Fastify({ logger: false });
    registerPublicConfigRoute(app, {
      repository: { findPublicClient: async () => hostile },
      allowedOrigins: async () => [],
      dependencies: deps,
    });
    await app.ready();

    const response = await request(app.server)
      .get('/api/v1/clients/app-a/public-config')
      .expect(200);

    expect(response.body.theme).toEqual({
      background: '#ffffff',
      dark: { ring: '#abcdef' },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/javascript|expression|color: red|extra/);
    await app.close();
  });

  it('exposes only the client enabled social providers, never credentials', async () => {
    const withProviders: PublicClientSource = {
      ...source,
      socialProviders: [
        { provider: 'google', label: 'Google' },
        { provider: 'facebook', label: 'Facebook' },
      ],
    };
    const app: FastifyInstance = Fastify({ logger: false });
    registerPublicConfigRoute(app, {
      repository: { findPublicClient: async () => withProviders },
      allowedOrigins: async () => [],
      dependencies: deps,
    });
    await app.ready();

    const response = await request(app.server)
      .get('/api/v1/clients/app-a/public-config')
      .expect(200);

    expect(response.body.socialProviders).toEqual([
      { provider: 'google', label: 'Google' },
      { provider: 'facebook', label: 'Facebook' },
    ]);
    const serialized = JSON.stringify(response.body).toLowerCase();
    for (const forbidden of [
      'clientkey',
      'clientsecret',
      'secret',
      'scope',
      'redirecturi',
      'allowedemaildomains',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    await app.close();
  });

  it('does not add CORS headers for a foreign origin', async () => {
    const app = publicApp();
    await app.ready();

    const response = await request(app.server)
      .get('/api/v1/clients/app-a/public-config')
      .set('Origin', 'https://evil.example')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('returns the same 404 for unknown and disabled clients', async () => {
    const app = publicApp();
    await app.ready();

    const response = await request(app.server)
      .get('/api/v1/clients/nope/public-config')
      .expect(404);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ status: 404, title: 'Client configuration not found' });
    await app.close();
  });

  it('rate limits a hot key with Retry-After', async () => {
    let now = 0;
    const app: FastifyInstance = Fastify({ logger: false });
    registerPublicConfigRoute(app, {
      repository: { findPublicClient: async () => source },
      allowedOrigins: async () => [],
      dependencies: deps,
      rateLimit: { windowSeconds: 60, max: 2 },
      now: () => now,
    });
    await app.ready();

    await request(app.server).get('/api/v1/clients/app-a/public-config').expect(200);
    await request(app.server).get('/api/v1/clients/app-a/public-config').expect(200);
    const limited = await request(app.server)
      .get('/api/v1/clients/app-a/public-config')
      .expect(429);
    expect(limited.headers['retry-after']).toBe('60');

    now = 61_000;
    await request(app.server).get('/api/v1/clients/app-a/public-config').expect(200);
    await app.close();
  });

  it('throttles enumeration across client ids from one address', async () => {
    let now = 0;
    const app: FastifyInstance = Fastify({ logger: false });
    registerPublicConfigRoute(app, {
      repository: { findPublicClient: async () => null },
      allowedOrigins: async () => [],
      dependencies: deps,
      rateLimit: { windowSeconds: 60, max: 2 },
      now: () => now,
    });
    await app.ready();

    // A distinct client id per request must not reset the window (card #70 finding 11).
    await request(app.server).get('/api/v1/clients/probe-1/public-config').expect(404);
    await request(app.server).get('/api/v1/clients/probe-2/public-config').expect(404);
    await request(app.server).get('/api/v1/clients/probe-3/public-config').expect(429);

    now = 30_000;
    const partial = await request(app.server)
      .get('/api/v1/clients/probe-4/public-config')
      .expect(429);
    // The caller is told the remaining window, not the whole one.
    expect(partial.headers['retry-after']).toBe('30');
    await app.close();
  });
});

function userInfoApp() {
  const app: FastifyInstance = Fastify({ logger: false });
  const keys = new SigningKeyManager(new MemorySigningKeyRepository());
  registerUserInfoRoute(app, {
    issuer,
    keys,
    users: {
      async findUserInfoProfile(userId) {
        if (userId !== 'user-1') {
          return null;
        }
        return {
          username: 'sara',
          email: 'sara@example.com',
          emailVerified: true,
          displayName: 'Sara',
          locale: 'fa-IR',
          avatarUrl: 'https://cdn.example.com/sara.png',
          phone: '+989120000000',
          phoneVerified: true,
        };
      },
    },
  });
  return { app, keys };
}

describe('GET /oauth2/userinfo', () => {
  it('returns only the claims granted by the token scopes', async () => {
    const { app, keys } = userInfoApp();
    await app.ready();

    const token = await keys.signAccessToken(
      { sub: 'user-1', client_id: 'app-a', token_use: 'access', scope: 'openid profile email' },
      { issuer, audience: 'app-a', subject: 'user-1', expiresInSeconds: 600 },
    );

    const response = await request(app.server)
      .get('/oauth2/userinfo')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      sub: 'user-1',
      name: 'Sara',
      preferred_username: 'sara',
      locale: 'fa-IR',
      picture: 'https://cdn.example.com/sara.png',
      email: 'sara@example.com',
      email_verified: true,
    });
    expect(response.body).not.toHaveProperty('phone_number');
    await app.close();
  });

  it('omits email and profile claims without the matching scope', async () => {
    const { app, keys } = userInfoApp();
    await app.ready();

    const token = await keys.signAccessToken(
      { sub: 'user-1', client_id: 'app-a', token_use: 'access', scope: 'openid' },
      { issuer, audience: 'app-a', subject: 'user-1', expiresInSeconds: 600 },
    );

    const response = await request(app.server)
      .get('/oauth2/userinfo')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({ sub: 'user-1' });
    await app.close();
  });

  it('rejects missing, malformed and foreign tokens with invalid_token', async () => {
    const { app } = userInfoApp();
    await app.ready();

    await request(app.server).get('/oauth2/userinfo').expect(401);
    await request(app.server)
      .get('/oauth2/userinfo')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);

    const otherKeys = new SigningKeyManager(new MemorySigningKeyRepository());
    const foreign = await otherKeys.signAccessToken(
      { sub: 'user-1', client_id: 'app-a', token_use: 'access', scope: 'openid' },
      {
        issuer: 'https://evil.example',
        audience: 'app-a',
        subject: 'user-1',
        expiresInSeconds: 600,
      },
    );
    const response = await request(app.server)
      .get('/oauth2/userinfo')
      .set('Authorization', `Bearer ${foreign}`)
      .expect(401);
    expect(response.headers['www-authenticate']).toContain('invalid_token');
    await app.close();
  });
});
