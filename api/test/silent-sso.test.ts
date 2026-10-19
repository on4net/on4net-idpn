import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  s256Challenge,
  type AuthorizationCodeRecord,
  type AuthorizationCodeRepository,
} from '../src/oidc/authorization-code.js';
import type { ClientAuthClientRecord, ClientAuthRepository } from '../src/oidc/client-auth.js';
import type { ClientRepository, OAuthClient } from '../src/oidc/client-repository.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import type { RefreshTokenRepository } from '../src/oidc/refresh-token.js';
import type { TokenProfile } from '../src/oidc/token-claims.js';
import type { IdpSession } from '../src/session/types.js';
import { buildServer } from '../src/server.js';

const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const issuer = 'https://auth.example.com';
const now = new Date('2026-10-18T12:00:00Z');
const authTime = '2026-10-18T11:55:00.000Z';
const createdAt = '2026-10-18T12:00:00.000Z';

const REDIRECT_URI: Record<AppClientId, string> = {
  'app-a': 'https://app-a.example.com/callback',
  'app-b': 'https://app-b.example.com/callback',
};

type AppClientId = 'app-a' | 'app-b';

const oauthClient = (clientId: AppClientId): OAuthClient => ({
  clientId,
  status: 'active',
  type: 'spa',
  redirectUris: [REDIRECT_URI[clientId]],
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  requirePkce: true,
  registrationPolicy: 'invite_only',
  mfaPolicy: 'optional',
});

const authClient = (clientId: AppClientId): ClientAuthClientRecord => ({
  clientId,
  status: 'active',
  type: 'spa',
  requirePkce: true,
  accessTokenTtl: 600,
  refreshTokenTtl: 2_592_000,
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  secretHashes: [],
});

const profile: TokenProfile = {
  id: 'user-1',
  username: 'sara',
  email: 'sara@example.com',
  emailVerified: true,
  displayName: 'Sara',
  locale: 'fa-IR',
  tenantId: 'tenant-1',
};

function memoryCodes() {
  const records = new Map<string, AuthorizationCodeRecord>();
  const repository: AuthorizationCodeRepository & {
    records: Map<string, AuthorizationCodeRecord>;
  } = {
    records,
    async create(record) {
      records.set(record.codeHash, record);
    },
    async findByHash(codeHash) {
      return records.get(codeHash) ?? null;
    },
    async markConsumed(codeHash, consumedAt) {
      const record = records.get(codeHash);
      if (record === undefined || record.consumedAt !== null) {
        return false;
      }
      records.set(codeHash, { ...record, consumedAt });
      return true;
    },
  };
  return repository;
}

const unusedRefreshTokens: RefreshTokenRepository = {
  async create() {},
  async findByHash() {
    return null;
  },
  async markRotated() {
    return false;
  },
  async revokeFamily() {
    return 0;
  },
  async revokeByHash() {
    return false;
  },
};

function session(overrides: Partial<IdpSession> = {}): IdpSession {
  return {
    sid: 'sid-shared',
    userId: profile.id,
    createdAt,
    lastSeenAt: createdAt,
    authTime,
    idleExpiresAt: '2026-10-18T12:30:00.000Z',
    absoluteExpiresAt: '2026-10-18T20:00:00.000Z',
    amr: ['pwd'],
    acr: 'urn:on4net:acr:pwd',
    ...overrides,
  };
}

let app: FastifyInstance;
let codes: ReturnType<typeof memoryCodes>;
let sessions: Map<string, IdpSession>;
let deniedConsent: Set<string>;
let keys: SigningKeyManager;

beforeAll(async () => {
  sessions = new Map();
  deniedConsent = new Set();
  codes = memoryCodes();
  keys = new SigningKeyManager(new MemorySigningKeyRepository());

  const clients: ClientRepository = {
    async findByClientId(clientId) {
      return clientId === 'app-a' || clientId === 'app-b' ? oauthClient(clientId) : null;
    },
  };
  const authClients: ClientAuthRepository = {
    async findForAuth(clientId) {
      return clientId === 'app-a' || clientId === 'app-b' ? authClient(clientId) : null;
    },
  };

  app = buildServer({
    issuer,
    keys,
    token: {
      clients: authClients,
      codes,
      refreshTokens: unusedRefreshTokens,
      users: {
        async findProfile(userId) {
          return userId === profile.id ? profile : null;
        },
      },
      sessions: {
        async read(sid) {
          return sessions.get(sid) ?? null;
        },
      },
      now: () => now,
    },
    authorize: {
      clients,
      isConsentGranted: async (_userId, clientId) => !deniedConsent.has(clientId),
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  sessions.clear();
  deniedConsent.clear();
  codes.records.clear();
});

interface AuthorizeOptions {
  prompt?: string;
  maxAge?: number;
  loginHint?: string;
  sid?: string;
}

async function authorize(clientId: AppClientId, options: AuthorizeOptions = {}) {
  const query: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI[clientId],
    scope: 'openid profile',
    state: `state-${clientId}`,
    nonce: `nonce-${clientId}`,
    code_challenge: s256Challenge(verifier),
    code_challenge_method: 'S256',
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    ...(options.maxAge === undefined ? {} : { max_age: String(options.maxAge) }),
    ...(options.loginHint === undefined ? {} : { login_hint: options.loginHint }),
  };

  const pending = request(app.server).get('/oauth2/authorize').query(query);
  if (options.sid !== undefined) {
    pending.set('Cookie', `idpn_session=${options.sid}`);
  }
  const response = await pending.expect(302);
  return {
    response,
    location: new URL(response.headers.location ?? ''),
  };
}

async function exchange(clientId: AppClientId, code: string) {
  const response = await request(app.server)
    .post('/oauth2/token')
    .send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI[clientId],
      client_id: clientId,
      code_verifier: verifier,
    })
    .expect(200);
  return response.body as { access_token: string; id_token: string; scope: string };
}

const authTimeSeconds = Math.floor(new Date(authTime).getTime() / 1000);
const createdAtSeconds = Math.floor(new Date(createdAt).getTime() / 1000);

function storedCode(clientId: AppClientId): AuthorizationCodeRecord {
  const record = [...codes.records.values()].find((entry) => entry.clientId === clientId);
  if (record === undefined) {
    throw new Error(`no authorization code stored for ${clientId}`);
  }
  return record;
}

describe('silent SSO across two clients', () => {
  it('issues app-a tokens from the IdP session and binds them to its sid', async () => {
    sessions.set('sid-shared', session());

    const { location } = await authorize('app-a', { sid: 'sid-shared' });
    expect(location.origin + location.pathname).toBe(REDIRECT_URI['app-a']);
    expect(location.searchParams.get('error')).toBeNull();
    const code = location.searchParams.get('code') ?? '';
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const tokens = await exchange('app-a', code);
    const access = await keys.verify(tokens.access_token, { issuer, audience: 'app-a' });
    expect(access).toMatchObject({
      aud: 'app-a',
      sub: profile.id,
      sid: 'sid-shared',
      auth_time: authTimeSeconds,
      client_id: 'app-a',
    });
    expect(access.auth_time).not.toBe(createdAtSeconds);

    const idToken = await keys.verify(tokens.id_token, { issuer, audience: 'app-a' });
    expect(idToken).toMatchObject({
      sid: 'sid-shared',
      auth_time: authTimeSeconds,
      nonce: 'nonce-app-a',
    });
  });

  it('uses the session authentication time, not the rotated creation time, in the code', async () => {
    sessions.set('sid-shared', session());

    await authorize('app-a', { sid: 'sid-shared' });

    const record = storedCode('app-a');
    expect(record.authTime).toEqual(new Date(authTime));
    expect(record.sessionId).toBe('sid-shared');
  });

  it('issues app-b a code with prompt=none without ever rendering login', async () => {
    sessions.set('sid-shared', session());

    const first = await authorize('app-a', { sid: 'sid-shared' });
    const codeA = first.location.searchParams.get('code') ?? '';
    expect(codeA).not.toBe('');

    const silent = await authorize('app-b', { prompt: 'none', sid: 'sid-shared' });
    expect(silent.location.origin + silent.location.pathname).toBe(REDIRECT_URI['app-b']);
    expect(silent.location.pathname).not.toBe('/login');
    expect(silent.location.searchParams.get('error')).toBeNull();
    expect(silent.location.searchParams.get('state')).toBe('state-app-b');
    const codeB = silent.location.searchParams.get('code') ?? '';
    expect(codeB).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const tokensA = await exchange('app-a', codeA);
    const tokensB = await exchange('app-b', codeB);

    const accessA = await keys.verify(tokensA.access_token, { issuer, audience: 'app-a' });
    const accessB = await keys.verify(tokensB.access_token, { issuer, audience: 'app-b' });
    expect(accessA).toMatchObject({ aud: 'app-a', sid: 'sid-shared', auth_time: authTimeSeconds });
    expect(accessB).toMatchObject({ aud: 'app-b', sid: 'sid-shared', auth_time: authTimeSeconds });

    // Same IdP session, distinct client audiences.
    expect(accessA.sid).toBe(accessB.sid);
    expect(accessA.auth_time).toBe(accessB.auth_time);
    expect(accessA.aud).not.toBe(accessB.aud);
    expect(storedCode('app-a').sessionId).toBe('sid-shared');
    expect(storedCode('app-b').sessionId).toBe('sid-shared');
  });

  it('returns login_required for prompt=none without a session and never renders login', async () => {
    const { location } = await authorize('app-b', { prompt: 'none' });

    expect(location.origin + location.pathname).toBe(REDIRECT_URI['app-b']);
    expect(location.pathname).not.toBe('/login');
    expect(location.searchParams.get('error')).toBe('login_required');
    expect(location.searchParams.get('state')).toBe('state-app-b');
    expect(location.searchParams.get('code')).toBeNull();
    expect(codes.records.size).toBe(0);
  });

  it('rejects silent SSO when the session was revoked', async () => {
    sessions.set('sid-shared', session());
    await authorize('app-a', { sid: 'sid-shared' });

    sessions.delete('sid-shared');

    const { location } = await authorize('app-b', { prompt: 'none', sid: 'sid-shared' });
    expect(location.searchParams.get('error')).toBe('login_required');
    expect(location.searchParams.get('code')).toBeNull();
    expect(location.pathname).not.toBe('/login');
  });

  it('returns consent_required for prompt=none and sends interactive requests to consent', async () => {
    sessions.set('sid-shared', session());
    deniedConsent.add('app-b');

    const silent = await authorize('app-b', { prompt: 'none', sid: 'sid-shared' });
    expect(silent.location.searchParams.get('error')).toBe('consent_required');
    expect(silent.location.searchParams.get('code')).toBeNull();
    expect(silent.location.pathname).not.toBe('/login');

    const interactive = await authorize('app-b', { sid: 'sid-shared' });
    expect(interactive.location.origin + interactive.location.pathname).toBe(`${issuer}/consent`);
    expect(codes.records.size).toBe(0);
  });
});

describe('max_age and auth_time semantics', () => {
  it('requires fresh authentication for max_age=0', async () => {
    sessions.set('sid-shared', session());

    const silent = await authorize('app-b', { prompt: 'none', maxAge: 0, sid: 'sid-shared' });
    expect(silent.location.searchParams.get('error')).toBe('login_required');
    expect(silent.location.searchParams.get('code')).toBeNull();
    expect(silent.location.pathname).not.toBe('/login');

    const interactive = await authorize('app-b', { maxAge: 0, sid: 'sid-shared' });
    expect(interactive.location.searchParams.get('error')).toBe('interaction_required');
    expect(interactive.location.searchParams.get('code')).toBeNull();
    expect(interactive.location.pathname).not.toBe('/login');

    expect(codes.records.size).toBe(0);
  });

  it('proceeds when max_age is larger than the session age', async () => {
    sessions.set('sid-shared', session());

    const { location } = await authorize('app-b', {
      prompt: 'none',
      maxAge: 3600,
      sid: 'sid-shared',
    });
    expect(location.searchParams.get('error')).toBeNull();
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const tokens = await exchange('app-b', location.searchParams.get('code') ?? '');
    const access = await keys.verify(tokens.access_token, { issuer, audience: 'app-b' });
    expect(access.auth_time).toBe(authTimeSeconds);
  });

  it('rejects a session older than max_age', async () => {
    sessions.set(
      'sid-shared',
      session({ authTime: '2026-10-18T08:00:00.000Z', createdAt: '2026-10-18T08:00:00.000Z' }),
    );

    const { location } = await authorize('app-b', {
      prompt: 'none',
      maxAge: 3600,
      sid: 'sid-shared',
    });
    expect(location.searchParams.get('error')).toBe('login_required');
    expect(location.searchParams.get('code')).toBeNull();
  });
});

describe('login_hint across authorize, login and return_to', () => {
  it('carries login_hint into the hosted login and returns to authorize after login', async () => {
    const login = await authorize('app-b', { loginHint: 'sara@example.com' });

    expect(login.location.origin + login.location.pathname).toBe(`${issuer}/login`);
    expect(login.location.searchParams.get('client_id')).toBe('app-b');
    expect(login.location.searchParams.get('login_hint')).toBe('sara@example.com');

    const returnTo = login.location.searchParams.get('return_to') ?? '';
    const returnUrl = new URL(returnTo, issuer);
    expect(returnUrl.pathname).toBe('/oauth2/authorize');
    expect(returnUrl.searchParams.get('client_id')).toBe('app-b');
    expect(returnUrl.searchParams.get('login_hint')).toBe('sara@example.com');
    expect(returnUrl.searchParams.get('prompt')).toBeNull();

    // After the login page authenticates the user, the same return_to yields a code.
    sessions.set('sid-shared', session());
    const resumed = await request(app.server)
      .get(`${returnUrl.pathname}${returnUrl.search}`)
      .set('Cookie', 'idpn_session=sid-shared')
      .expect(302);

    const resumedLocation = new URL(resumed.headers.location ?? '');
    expect(resumedLocation.origin + resumedLocation.pathname).toBe(REDIRECT_URI['app-b']);
    expect(resumedLocation.searchParams.get('error')).toBeNull();
    expect(resumedLocation.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
