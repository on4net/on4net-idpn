import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryRateLimiter } from '../http/rate-limit.js';
import { registerSetupRoutes, SETUP_RATE_LIMIT } from './routes.js';
import type { InstallInput, InstallOutcome, SetupStore } from './setup-types.js';
import { generateSetupToken, setupTokenMatches } from './token.js';

const TOKEN = 'T'.repeat(32);
const VALID = {
  token: TOKEN,
  username: 'Root.Admin',
  email: ' Root@Example.com ',
  displayName: 'Root Admin',
  password: 'correct horse battery staple',
};

function createStore(initial = false): SetupStore & { calls: InstallInput[]; installed: boolean } {
  const store = {
    installed: initial,
    calls: [] as InstallInput[],
    async isInstalled() {
      return store.installed;
    },
    async install(input: InstallInput): Promise<InstallOutcome> {
      if (store.installed) {
        return { ok: false, reason: 'already_installed' };
      }
      store.calls.push(input);
      store.installed = true;
      return { ok: true, userId: '00000000-0000-4000-8000-000000000001' };
    },
  };
  return store;
}

async function build(store: ReturnType<typeof createStore>, onInstalled = vi.fn()) {
  const app = Fastify();
  const rateLimit = createMemoryRateLimiter();
  registerSetupRoutes(app, {
    store,
    token: TOKEN,
    rateLimit,
    hash: async (plain) => `hashed:${plain.length}`,
    onInstalled,
  });
  await app.ready();
  return { app, onInstalled, rateLimit };
}

const post = (app: FastifyInstance, url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as object });

describe('setup token', () => {
  it('generates distinct url-safe tokens and compares in constant time', () => {
    const a = generateSetupToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(generateSetupToken()).not.toBe(a);
    expect(setupTokenMatches(a, a)).toBe(true);
    expect(setupTokenMatches(a, `${a}x`)).toBe(false);
    expect(setupTokenMatches(a, '')).toBe(false);
  });
});

describe('install wizard routes', () => {
  let store: ReturnType<typeof createStore>;
  beforeEach(() => {
    store = createStore();
  });

  it('reports the install state', async () => {
    const { app } = await build(store);
    const before = await app.inject({ method: 'GET', url: '/api/v1/setup/status' });
    expect(before.json()).toEqual({ installed: false });
    expect(before.headers['cache-control']).toBe('no-store');
  });

  it('accepts only the right token on verify', async () => {
    const { app } = await build(store);
    expect((await post(app, '/api/v1/setup/verify', { token: 'wrong' })).statusCode).toBe(403);
    expect((await post(app, '/api/v1/setup/verify', {})).statusCode).toBe(403);
    expect((await post(app, '/api/v1/setup/verify', { token: TOKEN })).statusCode).toBe(204);
  });

  it('rejects a wrong token before validating the rest of the body', async () => {
    const { app } = await build(store);
    const response = await post(app, '/api/v1/setup/complete', { token: 'nope', junk: true });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('invalid_setup_token');
    expect(store.calls).toHaveLength(0);
  });

  it('creates the administrator once with normalized identity and a hash', async () => {
    const { app, onInstalled } = await build(store);
    const response = await post(app, '/api/v1/setup/complete', {
      ...VALID,
      adminUrl: 'https://admin.example.com/some/path?x=1',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ installed: true });
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({
      username: 'root.admin',
      email: 'root@example.com',
      displayName: 'Root Admin',
      passwordHash: 'hashed:28',
      adminUrl: 'https://admin.example.com',
    });
    expect(JSON.stringify(store.calls[0])).not.toContain('correct horse');
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it('closes every setup write for good once installed', async () => {
    const { app } = await build(store);
    expect((await post(app, '/api/v1/setup/complete', VALID)).statusCode).toBe(201);

    const again = await post(app, '/api/v1/setup/complete', VALID);
    expect(again.statusCode).toBe(404);
    expect((await post(app, '/api/v1/setup/verify', { token: TOKEN })).statusCode).toBe(404);
    const status = await app.inject({ method: 'GET', url: '/api/v1/setup/status' });
    expect(status.json()).toEqual({ installed: true });
    expect(store.calls).toHaveLength(1);
  });

  it('is closed from the start on an installed instance', async () => {
    const { app } = await build(createStore(true));
    expect((await post(app, '/api/v1/setup/verify', { token: TOKEN })).statusCode).toBe(404);
    expect((await post(app, '/api/v1/setup/complete', VALID)).statusCode).toBe(404);
  });

  it('answers 404 when another request wins the race inside the store', async () => {
    const racing = createStore();
    racing.install = async () => ({ ok: false, reason: 'already_installed' });
    const { app } = await build(racing);
    expect((await post(app, '/api/v1/setup/complete', VALID)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/setup/status' })).json()).toEqual({
      installed: true,
    });
  });

  it('enforces the password policy including identity fragments', async () => {
    const { app } = await build(store);
    const weak = await post(app, '/api/v1/setup/complete', { ...VALID, password: 'short' });
    expect(weak.statusCode).toBe(422);
    expect(weak.json().violations).toContain('too_short');

    const identity = await post(app, '/api/v1/setup/complete', {
      ...VALID,
      password: 'my-root.admin-password-1',
    });
    expect(identity.json().violations).toContain('contains_identity');
    expect(store.calls).toHaveLength(0);
  });

  it('rejects unknown fields, bad emails and unsafe admin URLs', async () => {
    const { app } = await build(store);
    expect((await post(app, '/api/v1/setup/complete', { ...VALID, role: 'x' })).statusCode).toBe(
      422,
    );
    expect(
      (await post(app, '/api/v1/setup/complete', { ...VALID, email: 'nope' })).statusCode,
    ).toBe(422);
    for (const adminUrl of ['javascript:alert(1)', 'https://user:pw@admin.example.com']) {
      const response = await post(app, '/api/v1/setup/complete', { ...VALID, adminUrl });
      expect(response.statusCode).toBe(422);
    }
    expect(store.calls).toHaveLength(0);
  });

  it('maps an existing credentialed account to 409 and leaves the wizard open', async () => {
    store.install = async () => ({ ok: false, reason: 'conflict' });
    const { app } = await build(store);
    const response = await post(app, '/api/v1/setup/complete', VALID);
    expect(response.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/v1/setup/status' })).json()).toEqual({
      installed: false,
    });
  });

  it('requires a JSON body', async () => {
    const { app } = await build(store);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      headers: { 'content-type': 'text/plain' },
      payload: 'token=x',
    });
    expect(response.statusCode).toBe(400);
  });

  it('rate limits token guessing per address', async () => {
    const { app } = await build(store);
    for (let attempt = 0; attempt < SETUP_RATE_LIMIT.max; attempt += 1) {
      expect((await post(app, '/api/v1/setup/verify', { token: 'x' })).statusCode).toBe(403);
    }
    const blocked = await post(app, '/api/v1/setup/verify', { token: TOKEN });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe(String(SETUP_RATE_LIMIT.windowSeconds));
  });
});
