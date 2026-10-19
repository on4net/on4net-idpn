import Fastify from 'fastify';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  s256Challenge,
  type AuthorizationCodeRecord,
  type AuthorizationCodeRepository,
} from '../src/oidc/authorization-code.js';
import { registerAuthorizeRoute } from '../src/oidc/authorize-route.js';
import type { ClientRepository, OAuthClient } from '../src/oidc/client-repository.js';
import type { IdpSession } from '../src/session/types.js';

const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const issuer = 'https://auth.example.com';

const client: OAuthClient = {
  clientId: 'app-a',
  status: 'active',
  type: 'spa',
  redirectUris: ['https://app-a.example.com/callback'],
  scopes: ['openid', 'profile', 'idp.client-admin'],
  requirePkce: true,
  registrationPolicy: 'invite_only',
  mfaPolicy: 'optional',
};

const clients: ClientRepository = {
  async findByClientId(clientId) {
    return clientId === 'app-a' ? client : null;
  },
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

function session(overrides: Partial<IdpSession> = {}): IdpSession {
  return {
    sid: 'session-abc',
    userId: 'user-1',
    createdAt: '2026-10-18T09:00:00.000Z',
    lastSeenAt: '2026-10-18T09:00:00.000Z',
    authTime: '2026-10-18T09:00:00.000Z',
    idleExpiresAt: '2026-10-18T09:30:00.000Z',
    absoluteExpiresAt: '2026-10-18T17:00:00.000Z',
    amr: ['pwd'],
    acr: 'urn:on4net:acr:pwd',
    ...overrides,
  };
}

const baseQuery = {
  response_type: 'code',
  client_id: 'app-a',
  redirect_uri: 'https://app-a.example.com/callback',
  scope: 'openid profile',
  state: 'state-123',
  nonce: 'nonce-123',
  code_challenge: s256Challenge(verifier),
  code_challenge_method: 'S256',
};

function buildApp(options: {
  currentSession: IdpSession | null;
  consentGranted?: boolean;
  clientAdminEligible?: boolean;
  now?: Date;
}) {
  const app = Fastify({ logger: false });
  const codes = memoryCodes();
  registerAuthorizeRoute(app, {
    issuer,
    clients,
    codes,
    sessions: {
      async read(sid) {
        return options.currentSession !== null && sid === options.currentSession.sid
          ? options.currentSession
          : null;
      },
    },
    isConsentGranted: async () => options.consentGranted ?? true,
    isClientAdminEligible: async () => options.clientAdminEligible ?? true,
    now: () => options.now ?? new Date('2026-10-18T12:00:00Z'),
  });
  return { app, codes };
}

describe('GET /oauth2/authorize', () => {
  it('issues a code and redirects with state when a valid session exists', async () => {
    const { app, codes } = buildApp({ currentSession: session() });
    await app.ready();

    const response = await request(app.server)
      .get('/oauth2/authorize')
      .query(baseQuery)
      .set('Cookie', 'idpn_session=session-abc')
      .expect(302);

    const location = new URL(response.headers.location ?? '');
    expect(location.origin + location.pathname).toBe('https://app-a.example.com/callback');
    expect(location.searchParams.get('state')).toBe('state-123');
    const code = location.searchParams.get('code');
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers['cache-control']).toBe('no-store');

    expect(codes.records.size).toBe(1);
    const stored = [...codes.records.values()][0];
    expect(stored).toMatchObject({
      clientId: 'app-a',
      userId: 'user-1',
      sessionId: 'session-abc',
      redirectUri: 'https://app-a.example.com/callback',
      nonce: 'nonce-123',
    });
    expect(stored?.codeHash).not.toBe(code);

    await app.close();
  });

  it('issues the delegated admin scope only to an eligible user', async () => {
    const allowed = buildApp({ currentSession: session(), clientAdminEligible: true });
    await allowed.app.ready();
    const granted = await request(allowed.app.server)
      .get('/oauth2/authorize')
      .query({ ...baseQuery, scope: 'openid idp.client-admin' })
      .set('Cookie', 'idpn_session=session-abc')
      .expect(302);
    const grantedLocation = new URL(granted.headers.location ?? '');
    expect(grantedLocation.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await allowed.app.close();

    const denied = buildApp({ currentSession: session(), clientAdminEligible: false });
    await denied.app.ready();
    const refusal = await request(denied.app.server)
      .get('/oauth2/authorize')
      .query({ ...baseQuery, scope: 'openid idp.client-admin' })
      .set('Cookie', 'idpn_session=session-abc')
      .expect(302);
    const refusalLocation = new URL(refusal.headers.location ?? '');
    expect(refusalLocation.searchParams.get('error')).toBe('access_denied');
    expect(refusalLocation.searchParams.get('code')).toBeNull();
    expect(denied.codes.records.size).toBe(0);
    await denied.app.close();
  });

  it('returns invalid_request to the user agent for an unregistered redirect_uri', async () => {
    const { app } = buildApp({ currentSession: session() });
    await app.ready();

    const response = await request(app.server)
      .get('/oauth2/authorize')
      .query({ ...baseQuery, redirect_uri: 'https://evil.example/cb' })
      .expect(400);

    expect(response.body).toMatchObject({ error: 'invalid_request' });
    await app.close();
  });

  it('redirects errors back to the client when the redirect_uri is valid', async () => {
    const { app } = buildApp({ currentSession: session() });
    await app.ready();

    const response = await request(app.server)
      .get('/oauth2/authorize')
      .query({ ...baseQuery, response_type: 'token' })
      .expect(302);

    const location = new URL(response.headers.location ?? '');
    expect(location.searchParams.get('error')).toBe('unsupported_response_type');
    expect(location.searchParams.get('state')).toBe('state-123');
    await app.close();
  });

  it('sends interactive requests without a session to the hosted login', async () => {
    const { app } = buildApp({ currentSession: null });
    await app.ready();

    const response = await request(app.server)
      .get('/oauth2/authorize')
      .query(baseQuery)
      .expect(302);

    const location = new URL(response.headers.location ?? '');
    expect(location.origin + location.pathname).toBe(`${issuer}/login`);
    expect(location.searchParams.get('client_id')).toBe('app-a');
    const returnTo = new URL(location.searchParams.get('return_to') ?? '', issuer);
    expect(returnTo.pathname).toBe('/oauth2/authorize');
    expect(returnTo.searchParams.get('client_id')).toBe('app-a');
    expect(returnTo.searchParams.get('state')).toBe('state-123');
    await app.close();
  });

  it('carries ui_locales and login_hint into the hosted login URL', async () => {
    const { app } = buildApp({ currentSession: null });
    await app.ready();

    const response = await request(app.server)
      .get('/oauth2/authorize')
      .query({ ...baseQuery, ui_locales: 'fa-IR', login_hint: 'sara@example.com' })
      .expect(302);

    const location = new URL(response.headers.location ?? '');
    expect(location.searchParams.get('ui_locales')).toBe('fa-IR');
    expect(location.searchParams.get('login_hint')).toBe('sara@example.com');
    await app.close();
  });

  it('returns login_required for prompt=none without a session', async () => {
    const { app } = buildApp({ currentSession: null });
    await app.ready();

    const response = await request(app.server)
      .get('/oauth2/authorize')
      .query({ ...baseQuery, prompt: 'none' })
      .expect(302);

    const location = new URL(response.headers.location ?? '');
    expect(location.searchParams.get('error')).toBe('login_required');
    expect(location.searchParams.get('state')).toBe('state-123');
    await app.close();
  });

  it('enforces max_age by measuring from the authentication time', async () => {
    const { app } = buildApp({
      currentSession: session({ authTime: '2026-10-18T09:00:00.000Z' }),
      now: new Date('2026-10-18T12:00:00Z'),
    });
    await app.ready();

    const response = await request(app.server)
      .get('/oauth2/authorize')
      .query({ ...baseQuery, max_age: '60', prompt: 'none' })
      .expect(302);

    expect(new URL(response.headers.location ?? '').searchParams.get('error')).toBe(
      'login_required',
    );
    await app.close();
  });

  it('returns consent_required for prompt=none when consent is missing', async () => {
    const { app } = buildApp({ currentSession: session(), consentGranted: false });
    await app.ready();

    const response = await request(app.server)
      .get('/oauth2/authorize')
      .query({ ...baseQuery, prompt: 'none' })
      .set('Cookie', 'idpn_session=session-abc')
      .expect(302);

    expect(new URL(response.headers.location ?? '').searchParams.get('error')).toBe(
      'consent_required',
    );
    await app.close();
  });

  it('ignores a session cookie from another sid', async () => {
    const { app } = buildApp({ currentSession: session() });
    await app.ready();

    const response = await request(app.server)
      .get('/oauth2/authorize')
      .query(baseQuery)
      .set('Cookie', 'idpn_session=other-session')
      .expect(302);

    const location = new URL(response.headers.location ?? '');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('client_id')).toBe('app-a');
    await app.close();
  });
});
