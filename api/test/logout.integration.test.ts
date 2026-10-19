import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { decodeJwt } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AuditEventInput } from '../src/audit/sanitize.js';
import {
  BACKCHANNEL_LOGOUT_QUEUE_KEY,
  BackchannelLogoutDispatcher,
  RedisBackchannelLogoutQueue,
  type BackchannelDelivery,
  type BackchannelLogoutNotifyInput,
  type BackchannelLogoutSender,
} from '../src/oidc/backchannel-logout.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { LogoutTokenSigner, RedisLogoutTokenJtiRegistry } from '../src/oidc/logout-token.js';
import { createPrismaClientRepository } from '../src/oidc/prisma-client-repository.js';
import { createPrismaLogoutRepository } from '../src/oidc/prisma-logout-repository.js';
import { createPrismaRefreshTokenRepository } from '../src/oidc/prisma-refresh-repository.js';
import type {
  AuthorizationCodeRecord,
  AuthorizationCodeRepository,
} from '../src/oidc/authorization-code.js';
import { RedisSessionCache } from '../src/session/redis-cache.js';
import { RedisSessionStore } from '../src/session/store.js';
import type { IdpSession } from '../src/session/types.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { buildServer } from '../src/server.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'https://auth.example.com';
const ACR = 'urn:on4net:acr:pwd';
const policy = { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 };

interface ClientFixture {
  id: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUris: string[];
  backchannelLogoutUri: string | null;
}

class FakeBackchannelSender implements BackchannelLogoutSender {
  readonly calls: Array<{ uri: string; token: string }> = [];
  readonly failures = new Map<string, number>();

  async send(uri: string, token: string): Promise<void> {
    this.calls.push({ uri, token });
    const remaining = this.failures.get(uri) ?? 0;
    if (remaining > 0) {
      this.failures.set(uri, remaining - 1);
      throw new Error('client unavailable');
    }
  }
}

interface NotifyTracker {
  pending: Array<Promise<BackchannelDelivery[]>>;
  notify(input: BackchannelLogoutNotifyInput): Promise<BackchannelDelivery[]>;
}

let container: StartedPostgreSqlContainer | undefined;
let redisContainer: StartedRedisContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let redis: Redis;
let prisma: PrismaClient;
let connectionString: string;
let tenantId: string;
let userId: string;
let clientA: ClientFixture;
let clientB: ClientFixture;
let clientC: ClientFixture;
let clientD: ClientFixture;

let app: FastifyInstance;
let keys: SigningKeyManager;
let sessions: RedisSessionStore;
let sender: FakeBackchannelSender;
let jtiRegistry: RedisLogoutTokenJtiRegistry;
let signer: LogoutTokenSigner;
let tracker: NotifyTracker;
let audits: AuditEventInput[];

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString },
  });
}

async function createClient(input: {
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUris: string[];
  backchannelLogoutUri: string | null;
}): Promise<ClientFixture> {
  const row = await prisma.client.create({
    data: {
      clientId: input.clientId,
      name: input.clientId,
      type: 'spa',
      redirectUris: [input.redirectUri],
      postLogoutRedirectUris: input.postLogoutRedirectUris,
      allowedOrigins: [],
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      backchannelLogoutUri: input.backchannelLogoutUri,
      allowedEmailDomains: [],
      tenantId,
    },
  });
  return {
    id: row.id,
    clientId: row.clientId,
    redirectUri: input.redirectUri,
    postLogoutRedirectUris: input.postLogoutRedirectUris,
    backchannelLogoutUri: input.backchannelLogoutUri,
  };
}

async function createSession(client?: ClientFixture): Promise<IdpSession> {
  const session = await sessions.create({
    userId,
    tenantId,
    ...(client === undefined ? {} : { clientId: client.clientId }),
    amr: ['pwd'],
    acr: ACR,
  });
  await prisma.session.create({
    data: {
      id: session.sid,
      userId,
      clientId: client === undefined ? null : client.id,
      createdAt: new Date(session.createdAt),
      lastSeenAt: new Date(session.lastSeenAt),
      idleExpiresAt: new Date(session.idleExpiresAt),
      absoluteExpiresAt: new Date(session.absoluteExpiresAt),
      amr: session.amr,
      acr: session.acr,
    },
  });
  return session;
}

async function grantRefreshToken(sessionId: string, client: ClientFixture): Promise<void> {
  await prisma.refreshToken.create({
    data: {
      tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      familyId: randomUUID(),
      clientId: client.id,
      userId,
      sessionId,
      scope: ['openid'],
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

async function grantAuthorizationCode(sessionId: string, client: ClientFixture): Promise<void> {
  await prisma.authorizationCode.create({
    data: {
      codeHash: createHash('sha256').update(randomUUID()).digest('hex'),
      clientId: client.id,
      userId,
      sessionId,
      redirectUri: client.redirectUri,
      scope: ['openid'],
      codeChallenge: 'a'.repeat(43),
      authTime: new Date(),
      acr: ACR,
      amr: ['pwd'],
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
}

function idTokenClaims(input: {
  sid: string;
  clientId: string;
  issuer?: string;
  issuedAt?: number;
}): Record<string, unknown> {
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);
  return {
    iss: input.issuer ?? issuer,
    sub: userId,
    aud: input.clientId,
    iat: issuedAt,
    exp: issuedAt + 300,
    auth_time: issuedAt,
    acr: ACR,
    amr: ['pwd'],
    sid: input.sid,
  };
}

async function signIdTokenHint(input: {
  sid: string;
  clientId: string;
  issuer?: string;
  signingKeys?: SigningKeyManager;
}): Promise<string> {
  const usedKeys = input.signingKeys ?? keys;
  const issuedAt = Math.floor(Date.now() / 1000);
  return usedKeys.signAccessToken(
    idTokenClaims({
      sid: input.sid,
      clientId: input.clientId,
      ...(input.issuer === undefined ? {} : { issuer: input.issuer }),
      issuedAt,
    }),
    {
      issuer: input.issuer ?? issuer,
      audience: input.clientId,
      subject: userId,
      expiresInSeconds: 300,
      issuedAt,
    },
  );
}

function logoutRequest(params: Record<string, string>, sid?: string): request.Test {
  const query = new URLSearchParams(params).toString();
  const pending = request(app.server).get(`/oauth2/logout?${query}`);
  return sid === undefined ? pending : pending.set('Cookie', `idpn_session=${sid}`);
}

async function waitForNotifications(): Promise<BackchannelDelivery[]> {
  const pending = tracker.pending.splice(0, tracker.pending.length);
  const results = await Promise.all(pending);
  return results.flat();
}

function tokensFor(uri: string): string[] {
  return sender.calls.filter((call) => call.uri === uri).map((call) => call.token);
}

beforeAll(async () => {
  const externalDatabase = process.env.TEST_DATABASE_URL;
  if (externalDatabase !== undefined && externalDatabase !== '') {
    scratchDatabase = `idpn_logout_${Date.now()}`;
    serverClient = new Client({ connectionString: externalDatabase });
    await serverClient.connect();
    await serverClient.query(`CREATE DATABASE "${scratchDatabase}"`);
    const url = new URL(externalDatabase);
    url.pathname = `/${scratchDatabase}`;
    connectionString = url.toString();
  } else {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(180_000)
      .start();
    connectionString = container.getConnectionUri();
  }

  const externalRedis = process.env.TEST_REDIS_URL;
  if (externalRedis !== undefined && externalRedis !== '') {
    redis = new Redis(externalRedis);
  } else {
    redisContainer = await new RedisContainer('redis:7-alpine').withStartupTimeout(180_000).start();
    redis = new Redis(redisContainer.getConnectionUrl());
  }

  await migrateDeploy();
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  const tenant = await prisma.tenant.create({
    data: { slug: `logout-tenant-${Date.now()}`, name: 'Logout tenant' },
  });
  tenantId = tenant.id;
  const user = await prisma.user.create({
    data: {
      tenantId,
      username: `logoutuser${Date.now()}`,
      email: `logout${Date.now()}@example.com`,
      displayName: 'Logout User',
      status: 'active',
    },
  });
  userId = user.id;

  const suffix = Date.now();
  clientA = await createClient({
    clientId: `app-a-${suffix}`,
    redirectUri: 'https://app-a.example.com/callback',
    postLogoutRedirectUris: ['https://app-a.example.com/after-logout'],
    backchannelLogoutUri: 'https://app-a.example.com/auth/backchannel-logout',
  });
  clientB = await createClient({
    clientId: `app-b-${suffix}`,
    redirectUri: 'https://app-b.example.com/callback',
    postLogoutRedirectUris: ['https://app-b.example.com/after-logout'],
    backchannelLogoutUri: 'https://app-b.example.com/auth/backchannel-logout',
  });
  clientC = await createClient({
    clientId: `app-c-${suffix}`,
    redirectUri: 'https://app-c.example.com/callback',
    postLogoutRedirectUris: ['https://app-c.example.com/after-logout'],
    backchannelLogoutUri: 'https://app-c.example.com/auth/backchannel-logout',
  });
  // Stored despite the admin API normally rejecting wildcards: logout must still refuse it.
  clientD = await createClient({
    clientId: `app-d-${suffix}`,
    redirectUri: 'https://app-d.example.com/callback',
    postLogoutRedirectUris: ['https://app-d.example.com/*'],
    backchannelLogoutUri: null,
  });

  keys = new SigningKeyManager(new MemorySigningKeyRepository());
  sessions = new RedisSessionStore({ cache: new RedisSessionCache(redis), policy });
  const clients = createPrismaClientRepository(prisma);
  const refreshTokens = createPrismaRefreshTokenRepository(prisma);
  const codes: AuthorizationCodeRepository & {
    records: Map<string, AuthorizationCodeRecord>;
  } = {
    records: new Map(),
    async create(_record) {
      return undefined;
    },
    async findByHash() {
      return null;
    },
    async markConsumed() {
      return false;
    },
  };

  sender = new FakeBackchannelSender();
  jtiRegistry = new RedisLogoutTokenJtiRegistry(redis);
  signer = new LogoutTokenSigner({ issuer, keys, registry: jtiRegistry });
  const dispatcher = new BackchannelLogoutDispatcher({
    tokens: signer,
    sender,
    queue: new RedisBackchannelLogoutQueue(redis),
    retryDelaysMs: [1, 1],
    sleep: async () => undefined,
  });
  tracker = {
    pending: [],
    notify(input) {
      const delivery = dispatcher.notify(input);
      this.pending.push(delivery);
      return delivery;
    },
  };
  audits = [];

  app = buildServer({
    issuer,
    keys,
    token: {
      clients,
      codes,
      refreshTokens,
      users: {
        async findProfile(id) {
          return id === userId
            ? {
                id: userId,
                username: 'logout-user',
                email: 'logout@example.com',
                emailVerified: true,
                displayName: 'Logout User',
                locale: 'fa-IR',
                tenantId,
              }
            : null;
        },
      },
      sessions,
    },
    authorize: {
      clients,
      loginUrl: `${issuer}/login`,
    },
    logout: {
      clients,
      sessions,
      revocations: createPrismaLogoutRepository(prisma),
      backchannel: tracker,
      audit: {
        async record(event) {
          audits.push(event);
        },
      },
      cookie: { secure: true },
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  await redis?.quit();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
  await redisContainer?.stop();
});

beforeEach(async () => {
  sender.calls.length = 0;
  sender.failures.clear();
  tracker.pending.length = 0;
  audits.length = 0;
  await redis.del(BACKCHANNEL_LOGOUT_QUEUE_KEY);
});

describe('GET/POST /oauth2/logout (RP-initiated)', () => {
  it('revokes the session and grants, clears the cookie and redirects with state', async () => {
    const session = await createSession(clientA);
    await grantRefreshToken(session.sid, clientA);
    await grantRefreshToken(session.sid, clientB);
    const hint = await signIdTokenHint({ sid: session.sid, clientId: clientA.clientId });

    const response = await logoutRequest(
      {
        id_token_hint: hint,
        post_logout_redirect_uri: clientA.postLogoutRedirectUris[0] ?? '',
        state: 'state-abc',
        client_id: clientA.clientId,
      },
      session.sid,
    ).expect(302);

    const location = new URL(String(response.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe('https://app-a.example.com/after-logout');
    expect(location.searchParams.get('state')).toBe('state-abc');
    expect(response.headers['cache-control']).toBe('no-store');

    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('idpn_session=deleted');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    await expect(sessions.read(session.sid)).resolves.toBeNull();
    const row = await prisma.session.findUniqueOrThrow({ where: { id: session.sid } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokeReason).toBe('logout');
    const liveTokens = await prisma.refreshToken.count({
      where: { sessionId: session.sid, revokedAt: null },
    });
    expect(liveTokens).toBe(0);

    const deliveries = await waitForNotifications();
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((delivery) => delivery.status === 'delivered')).toBe(true);

    for (const [uri, audience] of [
      [clientA.backchannelLogoutUri, clientA.clientId],
      [clientB.backchannelLogoutUri, clientB.clientId],
    ] as const) {
      const [token] = tokensFor(uri ?? '');
      expect(token).toBeDefined();
      const payload = await keys.verify(String(token), { issuer, audience });
      expect(payload).toMatchObject({
        iss: issuer,
        aud: audience,
        sid: session.sid,
        sub: userId,
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      });
      expect(payload).not.toHaveProperty('nonce');
    }

    const sessionAudit = audits.find((event) => event.action === 'session.logout');
    expect(sessionAudit?.metadata).toMatchObject({ sid: session.sid, participants: 2 });
    const globalAudit = audits.find((event) => event.action === 'user.logout.global');
    expect(globalAudit?.metadata).toMatchObject({ sid: session.sid, participants: 2 });
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(hint);
    expect(serialized).not.toContain(String(tokensFor(clientA.backchannelLogoutUri ?? '')[0]));

    // The revoked session is rejected on the very next request (docs/roadmap.md phase 3).
    const authorizeQuery = new URLSearchParams({
      response_type: 'code',
      client_id: clientA.clientId,
      redirect_uri: clientA.redirectUri,
      scope: 'openid',
      state: 'state-after-logout',
      nonce: 'nonce-after-logout',
      code_challenge: 'b'.repeat(43),
      code_challenge_method: 'S256',
      prompt: 'none',
    });
    const next = await request(app.server)
      .get(`/oauth2/authorize?${authorizeQuery.toString()}`)
      .set('Cookie', `idpn_session=${session.sid}`)
      .expect(302);
    const nextLocation = new URL(String(next.headers.location));
    expect(`${nextLocation.origin}${nextLocation.pathname}`).toBe(clientA.redirectUri);
    expect(nextLocation.searchParams.get('error')).toBe('login_required');
  });

  it('supports POST form submissions', async () => {
    const session = await createSession(clientA);
    const hint = await signIdTokenHint({ sid: session.sid, clientId: clientA.clientId });

    await request(app.server)
      .post('/oauth2/logout')
      .type('form')
      .send({
        id_token_hint: hint,
        post_logout_redirect_uri: clientA.postLogoutRedirectUris[0] ?? '',
        state: 'form-state',
      })
      .expect(302)
      .expect((response) => {
        const location = new URL(String(response.headers.location));
        expect(location.searchParams.get('state')).toBe('form-state');
      });

    await expect(sessions.read(session.sid)).resolves.toBeNull();
  });

  it('rejects an invalid id_token_hint with a safe 400 and keeps the session alive', async () => {
    const session = await createSession(clientA);
    const untrustedKeys = new SigningKeyManager(new MemorySigningKeyRepository());

    const forged = await signIdTokenHint({
      sid: session.sid,
      clientId: clientA.clientId,
      signingKeys: untrustedKeys,
    });
    const wrongIssuer = await signIdTokenHint({
      sid: session.sid,
      clientId: clientA.clientId,
      issuer: 'https://attacker.example.com',
    });
    const unknownAudience = await signIdTokenHint({
      sid: session.sid,
      clientId: 'unknown-app',
    });

    for (const hint of [forged, wrongIssuer, unknownAudience, 'not-a-jwt']) {
      const response = await logoutRequest({
        id_token_hint: hint,
        post_logout_redirect_uri: clientA.postLogoutRedirectUris[0] ?? '',
      }).expect(400);

      expect(response.headers.location).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toMatchObject({ error: 'invalid_request' });
      expect(response.headers['set-cookie']).toBeUndefined();
    }

    const validHint = await signIdTokenHint({
      sid: session.sid,
      clientId: clientA.clientId,
    });
    await logoutRequest({
      id_token_hint: validHint,
      client_id: 'some-other-client',
    }).expect(400);

    await expect(sessions.read(session.sid)).resolves.not.toBeNull();
    const row = await prisma.session.findUniqueOrThrow({ where: { id: session.sid } });
    expect(row.revokedAt).toBeNull();
  });

  it('refuses unregistered, wildcard and hint-less redirects without logging out', async () => {
    const session = await createSession(clientA);
    const hint = await signIdTokenHint({ sid: session.sid, clientId: clientA.clientId });
    const wildcardHint = await signIdTokenHint({
      sid: session.sid,
      clientId: clientD.clientId,
    });

    const attempts: Array<Record<string, string>> = [
      { id_token_hint: hint, post_logout_redirect_uri: 'https://evil.example.com/after' },
      { id_token_hint: hint, post_logout_redirect_uri: 'https://app-a.example.com/*' },
      {
        id_token_hint: wildcardHint,
        post_logout_redirect_uri: 'https://app-d.example.com/*',
      },
      { post_logout_redirect_uri: clientA.postLogoutRedirectUris[0] ?? '' },
    ];

    for (const params of attempts) {
      const response = await logoutRequest(params).expect(400);
      expect(response.headers.location).toBeUndefined();
      expect(response.body).toMatchObject({ error: 'invalid_request' });
    }

    await expect(sessions.read(session.sid)).resolves.not.toBeNull();
    expect(sender.calls).toHaveLength(0);
  });

  it('logs out a cookie-only session with 204 and no redirect', async () => {
    const session = await createSession(clientA);

    const response = await logoutRequest({}, session.sid).expect(204);
    expect(response.headers.location).toBeUndefined();
    expect(String(response.headers['set-cookie'])).toContain('idpn_session=deleted');

    await expect(sessions.read(session.sid)).resolves.toBeNull();
    const deliveries = await waitForNotifications();
    expect(deliveries).toEqual([{ clientId: clientA.clientId, status: 'delivered', attempts: 1 }]);
    const [token] = tokensFor(clientA.backchannelLogoutUri ?? '');
    const payload = await keys.verify(String(token), {
      issuer,
      audience: clientA.clientId,
    });
    expect(payload).toMatchObject({ sid: session.sid, sub: userId });
  });
});

describe('back-channel logout delivery', () => {
  it('retries a failing client, queues it and never blocks the logout', async () => {
    const session = await createSession(clientA);
    await grantRefreshToken(session.sid, clientA);
    await grantRefreshToken(session.sid, clientB);
    sender.failures.set(clientA.backchannelLogoutUri ?? '', 1000);
    const hint = await signIdTokenHint({ sid: session.sid, clientId: clientA.clientId });

    await logoutRequest({
      id_token_hint: hint,
      post_logout_redirect_uri: clientA.postLogoutRedirectUris[0] ?? '',
    }).expect(302);

    const deliveries = await waitForNotifications();
    expect(deliveries).toEqual([
      { clientId: clientA.clientId, status: 'queued', attempts: 3 },
      { clientId: clientB.clientId, status: 'delivered', attempts: 1 },
    ]);
    expect(tokensFor(clientA.backchannelLogoutUri ?? '')).toHaveLength(3);
    expect(tokensFor(clientB.backchannelLogoutUri ?? '')).toHaveLength(1);

    const queued = await redis.lrange(BACKCHANNEL_LOGOUT_QUEUE_KEY, 0, -1);
    expect(queued).toHaveLength(1);
    const entry = JSON.parse(queued[0] ?? '{}') as {
      clientId: string;
      sid: string;
      uri: string;
      logoutToken: string;
      attempts: number;
    };
    expect(entry).toMatchObject({
      clientId: clientA.clientId,
      sid: session.sid,
      uri: clientA.backchannelLogoutUri,
      attempts: 3,
    });
    await expect(
      keys.verify(entry.logoutToken, { issuer, audience: clientA.clientId }),
    ).resolves.toMatchObject({ sid: session.sid, aud: clientA.clientId });

    await expect(sessions.read(session.sid)).resolves.toBeNull();
    expect(audits.find((event) => event.action === 'session.logout')?.metadata).toMatchObject({
      sid: session.sid,
      participants: 2,
    });
  });

  it('recovers when a client fails transiently', async () => {
    const session = await createSession(clientA);
    sender.failures.set(clientA.backchannelLogoutUri ?? '', 2);
    const hint = await signIdTokenHint({ sid: session.sid, clientId: clientA.clientId });

    await logoutRequest({ id_token_hint: hint }).expect(204);

    const deliveries = await waitForNotifications();
    expect(deliveries).toEqual([{ clientId: clientA.clientId, status: 'delivered', attempts: 3 }]);
    expect(tokensFor(clientA.backchannelLogoutUri ?? '')).toHaveLength(3);
    expect(await redis.llen(BACKCHANNEL_LOGOUT_QUEUE_KEY)).toBe(0);
  });

  it('notifies clients that only hold an authorization code for the session', async () => {
    const session = await createSession(clientA);
    await grantAuthorizationCode(session.sid, clientC);
    const hint = await signIdTokenHint({ sid: session.sid, clientId: clientA.clientId });

    await logoutRequest({ id_token_hint: hint }).expect(204);
    const deliveries = await waitForNotifications();

    expect(deliveries.map((delivery) => delivery.clientId).sort()).toEqual(
      [clientA.clientId, clientC.clientId].sort(),
    );
    expect(tokensFor(clientC.backchannelLogoutUri ?? '')).toHaveLength(1);
  });

  it('issues a unique jti per logout token and refuses to reuse a claimed jti', async () => {
    const first = await createSession(clientA);
    const firstHint = await signIdTokenHint({ sid: first.sid, clientId: clientA.clientId });
    await logoutRequest({ id_token_hint: firstHint }).expect(204);
    await waitForNotifications();

    const second = await createSession(clientA);
    const secondHint = await signIdTokenHint({ sid: second.sid, clientId: clientA.clientId });
    await logoutRequest({ id_token_hint: secondHint }).expect(204);
    await waitForNotifications();

    const tokens = tokensFor(clientA.backchannelLogoutUri ?? '');
    expect(tokens).toHaveLength(2);
    const [firstJti, secondJti] = tokens.map((token) => decodeJwt(token).jti);
    expect(firstJti).toBeDefined();
    expect(secondJti).toBeDefined();
    expect(firstJti).not.toBe(secondJti);

    await expect(jtiRegistry.claim(String(firstJti), 120)).resolves.toBe(false);
    expect(await redis.ttl(`idpn:logout-jti:${String(firstJti)}`)).toBeGreaterThan(0);
  });
});
