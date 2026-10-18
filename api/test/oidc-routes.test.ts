import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { buildServer } from '../src/server.js';

const issuer = 'https://auth.example.com';

const app = buildServer({
  issuer,
  keys: new SigningKeyManager(new MemorySigningKeyRepository()),
});

beforeAll(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
});

describe('GET /.well-known/openid-configuration', () => {
  it('returns the documented document with a long cache', async () => {
    const response = await request(app.server).get('/.well-known/openid-configuration').expect(200);

    expect(response.headers['cache-control']).toBe('public, max-age=3600');
    expect(response.body).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: `${issuer}/oauth2/token`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ['ES256'],
    });
    expect(String(response.headers['content-type'])).toContain('application/json');
  });
});

describe('GET /.well-known/jwks.json', () => {
  it('returns a verifiable ES256 key and never leaks private material', async () => {
    const response = await request(app.server).get('/.well-known/jwks.json').expect(200);

    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.body.keys).toHaveLength(1);
    expect(response.body.keys[0]).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
      use: 'sig',
      alg: 'ES256',
    });
    expect(JSON.stringify(response.body)).not.toContain('"d"');
  });
});

describe('health endpoint', () => {
  it('stays uncached', async () => {
    const response = await request(app.server).get('/healthz').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
