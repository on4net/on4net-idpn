import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import request, { type Response as SupertestResponse } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaRbacRepository } from '../src/admin/rbac/prisma-rbac-repository.js';
import { createSecretBox, type SecretBox } from '../src/crypto/secret-box.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPrismaLoginRepository } from '../src/login/prisma-repository.js';
import { createPrismaClientRepository } from '../src/oidc/prisma-client-repository.js';
import { createPrismaCodeRepository } from '../src/oidc/prisma-code-repository.js';
import { createPrismaRefreshTokenRepository } from '../src/oidc/prisma-refresh-repository.js';
import { createPrismaUserRepository } from '../src/oidc/prisma-user-repository.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { buildServer } from '../src/server.js';
import { RedisSessionCache } from '../src/session/redis-cache.js';
import { RedisSessionStore } from '../src/session/store.js';
import { codeChallengeFor } from '../src/social/login-request.js';
import { createPrismaSocialLoginRepository } from '../src/social/prisma-social-login-repository.js';
import type { SocialLoginRepository } from '../src/social/social-login-types.js';
import { RedisSocialTransactionStore } from '../src/social/transaction-store.js';
import {
  SocialAdapterError,
  type AuthorizationCodeExchange,
  type NormalizedSocialProfile,
  type SocialProviderAdapter,
  type SocialProviderId,
} from '../src/social/types.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3300';
const secretKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const appAGoogleSecret = 'GOCSPX-app-a-google-secret';
const appAFacebookSecret = 'GOCSPX-app-a-facebook-secret';
const appBGoogleSecret = 'GOCSPX-app-b-google-secret';
const appCGoogleSecret = 'GOCSPX-app-c-google-secret';
const CLIENT_STATE = 'client-state-value';
const CLIENT_NONCE = 'client-nonce-value';
const CLIENT_CHALLENGE = 'a'.repeat(43);

let postgres: StartedPostgreSqlContainer | undefined;
let redisContainer: StartedRedisContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let prisma: PrismaClient;
let keys: SigningKeyManager;
let redis: Redis;
let transactions: RedisSocialTransactionStore;
let box: SecretBox;
let socialRepository: SocialLoginRepository;
let app: ReturnType<typeof buildServer>;

let tenantId: string;
let appAId: string;
let appCId: string;
let defaultRoleId: string;

const connectionString = (): string => connectionStringValue;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

interface FakeAdapterState {
  profile: NormalizedSocialProfile | null;
  error: unknown;
  inputs: AuthorizationCodeExchange[];
}

const googleState: FakeAdapterState = { profile: null, error: null, inputs: [] };
const facebookState: FakeAdapterState = { profile: null, error: null, inputs: [] };

function fakeAdapter(provider: SocialProviderId, state: FakeAdapterState): SocialProviderAdapter {
  return {
    provider,
    async exchangeAuthorizationCode(input) {
      state.inputs.push(input);
      if (state.error !== null) {
        throw state.error;
      }
      if (state.profile === null) {
        throw new Error(`no ${provider} profile configured for this test`);
      }
      return state.profile;
    },
  };
}

const googleAdapter = fakeAdapter('google', googleState);
const facebookAdapter = fakeAdapter('facebook', facebookState);

const redirectUriFor = (clientId: string): string => `https://${clientId}.example/callback`;

function buildTestServer(repository: SocialLoginRepository = socialRepository) {
  const sessions = new RedisSessionStore({
    cache: new RedisSessionCache(redis),
    policy: { idleTtlSeconds: 1800, absoluteTtlSeconds: 28800 },
  });
  const loginRepository = createPrismaLoginRepository(prisma);

  return buildServer({
    issuer,
    keys,
    token: {
      clients: createPrismaClientRepository(prisma),
      codes: createPrismaCodeRepository(prisma),
      refreshTokens: createPrismaRefreshTokenRepository(prisma),
      users: createPrismaUserRepository(prisma),
      sessions,
    },
    authorize: {
      clients: createPrismaClientRepository(prisma),
      loginUrl: `${issuer}/login`,
      loginRequests: {
        create: (input) => transactions.createAuthorizeLoginRequest(input),
      },
    },
    social: {
      loginUrl: `${issuer}/login`,
      repository,
      transactions,
      secretBox: box,
      adapters: { google: googleAdapter, facebook: facebookAdapter },
      sessions,
      persistSession: (input) => loginRepository.persistSession(input),
      audit: createPrismaAdminAudit(prisma),
      cookie: { secure: false, idleTtlSeconds: 1800, absoluteTtlSeconds: 28800 },
    },
  });
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_social_login_${Date.now()}`;
    serverClient = new Client({ connectionString: external });
    await serverClient.connect();
    await serverClient.query(`CREATE DATABASE "${scratchDatabase}"`);
    const url = new URL(external);
    url.pathname = `/${scratchDatabase}`;
    connectionStringValue = url.toString();
  } else {
    postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(180_000)
      .start();
    connectionStringValue = postgres.getConnectionUri();
  }
  await migrateDeploy();
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionStringValue }) });

  const externalRedis = process.env.TEST_REDIS_URL;
  if (externalRedis !== undefined && externalRedis !== '') {
    redis = new Redis(externalRedis);
  } else {
    redisContainer = await new RedisContainer('redis:7-alpine').withStartupTimeout(180_000).start();
    redis = new Redis(redisContainer.getConnectionUrl());
  }
  await redis.flushdb();

  keys = new SigningKeyManager(new MemorySigningKeyRepository());
  await keys.ensureKey();
  box = createSecretBox(secretKey);
  transactions = new RedisSocialTransactionStore(redis);
  socialRepository = createPrismaSocialLoginRepository(prisma, {
    rbac: createPrismaRbacRepository(prisma),
  });
  app = buildTestServer();
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  tenantId = tenant.id;

  const newClient = async (
    clientId: string,
    options: {
      registrationPolicy?: 'invite_only' | 'self_service' | 'disabled';
      allowedEmailDomains?: string[];
      status?: 'active' | 'disabled';
      scopes?: string[];
    } = {},
  ) =>
    prisma.client.create({
      data: {
        clientId,
        name: clientId,
        type: 'web',
        redirectUris: [redirectUriFor(clientId)],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes: options.scopes ?? ['openid', 'profile', 'email', 'offline_access'],
        registrationPolicy: options.registrationPolicy ?? 'invite_only',
        allowedEmailDomains: options.allowedEmailDomains ?? [],
        status: options.status ?? 'active',
        tenantId: tenant.id,
      },
    });

  const appA = await newClient('app-a', { registrationPolicy: 'self_service' });
  const appB = await newClient('app-b', { registrationPolicy: 'invite_only' });
  const appC = await newClient('app-c', {
    registrationPolicy: 'invite_only',
    allowedEmailDomains: ['partner.test'],
  });
  const appDisabled = await newClient('app-disabled', {
    registrationPolicy: 'self_service',
    status: 'disabled',
  });
  const adminPanel = await newClient('admin-panel', {
    registrationPolicy: 'self_service',
    scopes: ['openid', 'idp.admin'],
  });
  appAId = appA.id;
  appCId = appC.id;

  const newProvider = (
    client: { id: string },
    provider: SocialProviderId,
    clientKey: string,
    secret: string,
    enabled = true,
  ) =>
    prisma.clientSocialProvider.create({
      data: {
        clientId: client.id,
        provider,
        clientKey,
        clientSecretEncrypted: new Uint8Array(box.encrypt(secret)),
        scopes: ['openid', 'email', 'profile'],
        allowedEmailDomains: [],
        enabled,
      },
    });

  await newProvider(appA, 'google', 'app-a-google-key', appAGoogleSecret);
  await newProvider(appA, 'facebook', 'app-a-facebook-key', appAFacebookSecret);
  await newProvider(appB, 'google', 'app-b-google-key', appBGoogleSecret);
  await newProvider(appB, 'facebook', 'app-b-facebook-key', appAFacebookSecret, false);
  await newProvider(appC, 'google', 'app-c-google-key', appCGoogleSecret);
  await newProvider(appDisabled, 'google', 'app-disabled-google-key', appAGoogleSecret);
  await newProvider(adminPanel, 'google', 'admin-panel-google-key', appAGoogleSecret);

  const role = await prisma.role.create({
    data: {
      key: 'app-a:member',
      name: 'App A member',
      description: 'default role for app-a',
      clientId: appA.id,
      isDefault: true,
    },
  });
  defaultRoleId = role.id;
}, 600_000);

beforeEach(() => {
  googleState.profile = null;
  googleState.error = null;
  googleState.inputs.length = 0;
  facebookState.profile = null;
  facebookState.error = null;
  facebookState.inputs.length = 0;
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  await redis?.quit();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await redisContainer?.stop();
  await postgres?.stop();
});

interface StartedFlow {
  /** Absolute authorize URL stored on the server as `return_to`. */
  absoluteReturnTo: string;
  state: string;
  nonce: string | null;
  codeChallenge: string;
  providerUrl: URL;
}

const profile = (
  provider: SocialProviderId,
  overrides: Partial<NormalizedSocialProfile> = {},
): NormalizedSocialProfile => ({
  provider,
  providerUserId: `${provider}-${randomUUID()}`,
  email: `user-${randomUUID()}@app-a.test`,
  emailVerified: provider === 'google',
  displayName: 'Test User',
  avatarUrl: null,
  locale: 'en',
  ...overrides,
});

async function startFlow(
  clientId: string,
  provider: SocialProviderId,
  target = app,
): Promise<StartedFlow> {
  const authorizeParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUriFor(clientId),
    scope: 'openid profile',
    state: CLIENT_STATE,
    nonce: CLIENT_NONCE,
    code_challenge: CLIENT_CHALLENGE,
    code_challenge_method: 'S256',
  });
  const login = await request(target.server)
    .get(`/oauth2/authorize?${authorizeParams.toString()}`)
    .expect(302);
  const loginLocation = new URL(String(login.headers.location));
  expect(loginLocation.pathname).toBe('/login');
  const loginRequest = loginLocation.searchParams.get('login_request');
  expect(loginRequest).toBeTruthy();

  const start = await request(target.server)
    .get(`/oauth2/social/${clientId}/${provider}/start`)
    .query({ login_request: loginRequest })
    .expect(302);
  const providerUrl = new URL(String(start.headers.location));
  const state = providerUrl.searchParams.get('state');
  expect(state).toBeTruthy();

  return {
    absoluteReturnTo: new URL(loginLocation.searchParams.get('return_to') ?? '', issuer).toString(),
    state: state ?? '',
    nonce: providerUrl.searchParams.get('nonce'),
    codeChallenge: providerUrl.searchParams.get('code_challenge') ?? '',
    providerUrl,
  };
}

const callback = (
  clientId: string,
  provider: SocialProviderId,
  flow: StartedFlow,
  query: Record<string, string> = {},
  target = app,
) =>
  request(target.server)
    .get(`/oauth2/social/${clientId}/${provider}/callback`)
    .query({ code: 'provider-code', state: flow.state, ...query });

const sessionCookie = (response: SupertestResponse): string =>
  String(response.headers['set-cookie']).split(';')[0] ?? '';

const userByEmail = (email: string) =>
  prisma.user.findUnique({
    where: { tenantId_email: { tenantId, email: email.toLowerCase() } },
    select: { id: true, emailVerifiedAt: true, status: true },
  });

const membershipFor = (clientUuid: string, userId: string) =>
  prisma.clientMembership.findFirst({
    where: { clientId: clientUuid, userId, loginContextId: null },
    select: { id: true, status: true },
  });

const auditsSince = (since: Date) =>
  prisma.auditEvent.findMany({
    where: { occurredAt: { gte: since } },
    select: { action: true, result: true, metadata: true },
    orderBy: { occurredAt: 'asc' },
  });

describe('per-client social login', () => {
  it('creates a self-service user, links the identity, sets the session and returns to /authorize', async () => {
    const since = new Date();
    const socialProfile = profile('google');
    googleState.profile = socialProfile;

    const flow = await startFlow('app-a', 'google');
    expect(flow.providerUrl.searchParams.get('client_id')).toBe('app-a-google-key');
    expect(flow.providerUrl.searchParams.get('redirect_uri')).toBe(
      `${issuer}/oauth2/social/app-a/google/callback`,
    );
    expect(flow.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.nonce).toBeTruthy();
    expect(flow.codeChallenge).toBeTruthy();

    const response = await callback('app-a', 'google', flow).expect(302);
    expect(response.headers.location).toBe(flow.absoluteReturnTo);

    const cookie = sessionCookie(response);
    expect(cookie).toContain('idpn_session=');
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(response.headers['set-cookie'])).toContain('SameSite=Lax');
    expect(response.headers['cache-control']).toBe('no-store');

    // The exchange used this client's credential and the server-side PKCE/nonce values.
    const exchange = googleState.inputs.at(-1);
    expect(exchange).toMatchObject({
      code: 'provider-code',
      clientKey: 'app-a-google-key',
      clientSecret: appAGoogleSecret,
      redirectUri: `${issuer}/oauth2/social/app-a/google/callback`,
    });
    expect(codeChallengeFor(exchange?.codeVerifier ?? '')).toBe(flow.codeChallenge);
    expect(exchange?.nonce).toBe(flow.nonce);

    const user = await userByEmail(socialProfile.email ?? '');
    expect(user).not.toBeNull();
    expect(user?.status).toBe('active');
    expect(user?.emailVerifiedAt).not.toBeNull();

    const identity = await prisma.identity.findUnique({
      where: {
        provider_providerUserId: {
          provider: 'google',
          providerUserId: socialProfile.providerUserId,
        },
      },
      select: { userId: true },
    });
    expect(identity?.userId).toBe(user?.id);

    const membership = await membershipFor(appAId, user?.id ?? '');
    expect(membership?.status).toBe('active');

    const roles = await prisma.assignment.findMany({
      where: { subjectId: user?.id, roleId: defaultRoleId },
      select: { id: true },
    });
    expect(roles).toHaveLength(1);

    const audits = await auditsSince(since);
    expect(audits.some((event) => event.action === 'user.create')).toBe(true);
    expect(audits.some((event) => event.action === 'social.login.succeeded')).toBe(true);
    const login = audits.find((event) => event.action === 'social.login.succeeded');
    expect(login?.metadata).toMatchObject({
      provider: 'google',
      identity: 'created',
      membership: 'active',
      membershipCreated: true,
    });

    // Continue the OIDC flow with the new session: /authorize must issue a code.
    const authorizeTarget = new URL(flow.absoluteReturnTo);
    const follow = await request(app.server)
      .get(`${authorizeTarget.pathname}${authorizeTarget.search}`)
      .set('Cookie', cookie)
      .expect(302);
    const finalRedirect = new URL(String(follow.headers.location));
    expect(`${finalRedirect.origin}${finalRedirect.pathname}`).toBe(redirectUriFor('app-a'));
    expect(finalRedirect.searchParams.get('code')).toBeTruthy();
    expect(finalRedirect.searchParams.get('state')).toBe(CLIENT_STATE);

    // Audit metadata never carries provider tokens, codes or secrets.
    const auditPayload = JSON.stringify(audits.map((event) => event.metadata));
    for (const forbidden of [appAGoogleSecret, 'provider-code', 'access_token', 'id_token']) {
      expect(auditPayload).not.toContain(forbidden);
    }
  }, 60_000);

  it('denies registration for an invite-only app without an allowlist match', async () => {
    const since = new Date();
    const socialProfile = profile('google', { email: `blocked-${randomUUID()}@unlisted.test` });
    googleState.profile = socialProfile;

    const flow = await startFlow('app-b', 'google');
    const response = await callback('app-b', 'google', flow).expect(302);
    const location = new URL(String(response.headers.location));

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('return_to')).toBe(flow.absoluteReturnTo);
    expect(response.headers['set-cookie']).toBeUndefined();

    await expect(userByEmail(socialProfile.email ?? '')).resolves.toBeNull();
    const identity = await prisma.identity.findUnique({
      where: {
        provider_providerUserId: {
          provider: 'google',
          providerUserId: socialProfile.providerUserId,
        },
      },
    });
    expect(identity).toBeNull();

    const audits = await auditsSince(since);
    const failure = audits.find((event) => event.action === 'social.login.failed');
    expect(failure?.metadata).toMatchObject({
      provider: 'google',
      reason: 'registration_denied',
      error: 'access_denied',
    });
  }, 60_000);

  it('admits a domain-allowlisted address to an invite-only app', async () => {
    const socialProfile = profile('google', { email: 'engineer@partner.test' });
    googleState.profile = socialProfile;

    const flow = await startFlow('app-c', 'google');
    await callback('app-c', 'google', flow).expect(302);

    const user = await userByEmail('engineer@partner.test');
    expect(user).not.toBeNull();
    const membership = await membershipFor(appCId, user?.id ?? '');
    expect(membership?.status).toBe('active');
  }, 60_000);

  it('links a verified provider email to an existing central user', async () => {
    const since = new Date();
    const email = `linked-${randomUUID()}@app-a.test`;
    const existing = await prisma.user.create({
      data: {
        tenantId,
        username: `linked-${randomUUID().slice(0, 8)}`,
        email,
        displayName: 'Existing User',
        status: 'active',
      },
      select: { id: true },
    });
    const socialProfile = profile('google', { email, emailVerified: true });
    googleState.profile = socialProfile;

    const flow = await startFlow('app-a', 'google');
    await callback('app-a', 'google', flow).expect(302);

    const identity = await prisma.identity.findUnique({
      where: {
        provider_providerUserId: {
          provider: 'google',
          providerUserId: socialProfile.providerUserId,
        },
      },
      select: { userId: true },
    });
    expect(identity?.userId).toBe(existing.id);

    const usersWithEmail = await prisma.user.count({ where: { tenantId, email } });
    expect(usersWithEmail).toBe(1);
    expect((await membershipFor(appAId, existing.id))?.status).toBe('active');

    const audits = await auditsSince(since);
    expect(audits.some((event) => event.action === 'account.link')).toBe(true);
    const login = audits.find((event) => event.action === 'social.login.succeeded');
    expect(login?.metadata).toMatchObject({ identity: 'linked' });
    expect(audits.some((event) => event.action === 'user.create')).toBe(false);
  }, 60_000);

  it('never auto-links an unverified Facebook email to an existing user', async () => {
    const since = new Date();
    const email = `victim-${randomUUID()}@app-a.test`;
    const existing = await prisma.user.create({
      data: {
        tenantId,
        username: `victim-${randomUUID().slice(0, 8)}`,
        email,
        displayName: 'Victim',
        status: 'active',
      },
      select: { id: true },
    });
    const socialProfile = profile('facebook', { email, emailVerified: false });
    facebookState.profile = socialProfile;

    const flow = await startFlow('app-a', 'facebook');
    const response = await callback('app-a', 'facebook', flow).expect(302);
    const location = new URL(String(response.headers.location));

    expect(location.searchParams.get('error')).toBe('social_email_unverified');
    expect(response.headers['set-cookie']).toBeUndefined();

    const identity = await prisma.identity.findUnique({
      where: {
        provider_providerUserId: {
          provider: 'facebook',
          providerUserId: socialProfile.providerUserId,
        },
      },
    });
    expect(identity).toBeNull();
    expect(await prisma.user.count({ where: { tenantId, email } })).toBe(1);
    expect(await membershipFor(appAId, existing.id)).toBeNull();

    const audits = await auditsSince(since);
    expect(audits.find((event) => event.action === 'social.login.failed')?.metadata).toMatchObject({
      reason: 'unverified_email_matches_account',
    });
  }, 60_000);

  it('returns a safe conflict when the identity link loses a unique-constraint race', async () => {
    const since = new Date();
    const email = `race-${randomUUID()}@app-a.test`;
    const owner = await prisma.user.create({
      data: {
        tenantId,
        username: `race-owner-${randomUUID().slice(0, 8)}`,
        email: `owner-${randomUUID()}@app-a.test`,
        displayName: 'Identity Owner',
        status: 'active',
      },
      select: { id: true },
    });
    const target = await prisma.user.create({
      data: {
        tenantId,
        username: `race-target-${randomUUID().slice(0, 8)}`,
        email,
        displayName: 'Email Owner',
        status: 'active',
      },
      select: { id: true },
    });
    const socialProfile = profile('google', { providerUserId: 'race-subject', email });
    googleState.profile = socialProfile;
    await prisma.identity.create({
      data: {
        userId: owner.id,
        provider: 'google',
        providerUserId: 'race-subject',
      },
    });

    // Simulate the race: the first lookup misses, so the route decides to link by email.
    let firstLookup = true;
    const racing: SocialLoginRepository = {
      ...socialRepository,
      async findIdentity(provider, providerUserId) {
        if (firstLookup && providerUserId === 'race-subject') {
          firstLookup = false;
          return null;
        }
        return socialRepository.findIdentity(provider, providerUserId);
      },
    };
    const racingApp = buildTestServer(racing);
    await racingApp.ready();

    const flow = await startFlow('app-a', 'google', racingApp);
    const response = await callback('app-a', 'google', flow, {}, racingApp).expect(302);
    const location = new URL(String(response.headers.location));

    expect(location.searchParams.get('error')).toBe('social_account_conflict');
    expect(response.headers['set-cookie']).toBeUndefined();

    const identities = await prisma.identity.findMany({
      where: { provider: 'google', providerUserId: 'race-subject' },
      select: { userId: true },
    });
    expect(identities).toEqual([{ userId: owner.id }]);
    expect(await membershipFor(appAId, target.id)).toBeNull();
    expect(await membershipFor(appAId, owner.id)).toBeNull();

    const audits = await auditsSince(since);
    expect(audits.find((event) => event.action === 'social.login.failed')?.metadata).toMatchObject({
      reason: 'identity_conflict',
      error: 'social_account_conflict',
    });

    await racingApp.close();
  }, 60_000);

  it('blocks a suspended membership without deleting the user or identity', async () => {
    const email = `suspended-${randomUUID()}@app-a.test`;
    const user = await prisma.user.create({
      data: {
        tenantId,
        username: `suspended-${randomUUID().slice(0, 8)}`,
        email,
        displayName: 'Suspended',
        status: 'active',
      },
      select: { id: true },
    });
    const identity = await prisma.identity.create({
      data: {
        userId: user.id,
        provider: 'google',
        providerUserId: `suspended-${randomUUID()}`,
      },
      select: { id: true, providerUserId: true },
    });
    await prisma.clientMembership.create({
      data: {
        clientId: appAId,
        userId: user.id,
        status: 'suspended',
      },
    });
    googleState.profile = profile('google', {
      providerUserId: identity.providerUserId,
      email,
      emailVerified: true,
    });

    const flow = await startFlow('app-a', 'google');
    const response = await callback('app-a', 'google', flow).expect(302);
    const location = new URL(String(response.headers.location));

    expect(location.searchParams.get('error')).toBe('social_membership_suspended');
    expect(response.headers['set-cookie']).toBeUndefined();

    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    expect(await prisma.identity.findUnique({ where: { id: identity.id } })).not.toBeNull();
    expect((await membershipFor(appAId, user.id))?.status).toBe('suspended');
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  }, 60_000);

  it('rejects a cross-client callback and burns the state', async () => {
    const since = new Date();
    const socialProfile = profile('google');
    googleState.profile = socialProfile;

    const flow = await startFlow('app-a', 'google');
    const response = await callback('app-b', 'google', flow).expect(302);
    const location = new URL(String(response.headers.location));

    expect(location.searchParams.get('error')).toBe('social_state_invalid');
    expect(response.headers['set-cookie']).toBeUndefined();
    await expect(userByEmail(socialProfile.email ?? '')).resolves.toBeNull();

    // Single use: the legitimate client cannot replay the state either.
    const replay = await callback('app-a', 'google', flow).expect(302);
    expect(new URL(String(replay.headers.location)).searchParams.get('error')).toBe(
      'social_state_invalid',
    );
    expect(replay.headers['set-cookie']).toBeUndefined();

    const audits = await auditsSince(since);
    expect(
      audits
        .filter((event) => event.action === 'social.login.failed')
        .map((event) => event.metadata),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'cross_client_callback' }),
        expect.objectContaining({ reason: 'state_expired_or_replayed' }),
      ]),
    );
    // The exchange never happened for either rejected callback.
    expect(googleState.inputs).toHaveLength(0);
  }, 60_000);

  it('maps adapter and provider failures to safe social errors', async () => {
    googleState.error = new SocialAdapterError('invalid_grant', 'google', 'code rejected');
    const invalidGrant = await startFlow('app-a', 'google');
    const grantResponse = await callback('app-a', 'google', invalidGrant).expect(302);
    expect(new URL(String(grantResponse.headers.location)).searchParams.get('error')).toBe(
      'social_provider_error',
    );

    googleState.error = new SocialAdapterError(
      'email_unverified',
      'google',
      'email is not verified',
    );
    const unverifiedFlow = await startFlow('app-a', 'google');
    const unverifiedResponse = await callback('app-a', 'google', unverifiedFlow).expect(302);
    expect(new URL(String(unverifiedResponse.headers.location)).searchParams.get('error')).toBe(
      'social_email_unverified',
    );

    googleState.error = null;
    googleState.profile = profile('google');
    const cancelledFlow = await startFlow('app-a', 'google');
    const cancelled = await callback('app-a', 'google', cancelledFlow, {
      error: 'access_denied',
      error_description: 'raw provider detail',
    }).expect(302);
    const cancelledLocation = new URL(String(cancelled.headers.location));
    expect(cancelledLocation.searchParams.get('error')).toBe('social_provider_error');
    expect(String(cancelled.headers.location)).not.toContain('raw provider detail');
  }, 60_000);

  it('rejects a disabled provider and a disabled client at start', async () => {
    const loginRequest = await transactions.createAuthorizeLoginRequest({
      clientId: 'app-b',
      authorizeUrl: `${issuer}/oauth2/authorize?client_id=app-b&state=${CLIENT_STATE}`,
    });
    const disabledProvider = await request(app.server)
      .get('/oauth2/social/app-b/facebook/start')
      .query({ login_request: loginRequest })
      .expect(400);
    expect(disabledProvider.body).toEqual({ error: 'social_provider_disabled' });

    const disabledClientRequest = await transactions.createAuthorizeLoginRequest({
      clientId: 'app-disabled',
      authorizeUrl: `${issuer}/oauth2/authorize?client_id=app-disabled&state=${CLIENT_STATE}`,
    });
    const disabledClient = await request(app.server)
      .get('/oauth2/social/app-disabled/google/start')
      .query({ login_request: disabledClientRequest })
      .expect(400);
    expect(disabledClient.body).toEqual({ error: 'social_provider_disabled' });

    // The administration panel never accepts social login, even with a configured provider.
    const adminRequest = await transactions.createAuthorizeLoginRequest({
      clientId: 'admin-panel',
      authorizeUrl: `${issuer}/oauth2/authorize?client_id=admin-panel&state=${CLIENT_STATE}`,
    });
    const adminClient = await request(app.server)
      .get('/oauth2/social/admin-panel/google/start')
      .query({ login_request: adminRequest })
      .expect(400);
    expect(adminClient.body).toEqual({ error: 'social_provider_disabled' });
  }, 60_000);

  it('requires a single-use login_request bound to the path client', async () => {
    const missing = await request(app.server).get('/oauth2/social/app-a/google/start').expect(400);
    expect(missing.body).toEqual({ error: 'social_state_invalid' });

    const loginRequest = await transactions.createAuthorizeLoginRequest({
      clientId: 'app-a',
      authorizeUrl: `${issuer}/oauth2/authorize?client_id=app-a&state=${CLIENT_STATE}`,
    });
    await request(app.server)
      .get('/oauth2/social/app-a/google/start')
      .query({ login_request: loginRequest })
      .expect(302);

    // The login_request was consumed by the first start.
    const replay = await request(app.server)
      .get('/oauth2/social/app-a/google/start')
      .query({ login_request: loginRequest })
      .expect(400);
    expect(replay.body).toEqual({ error: 'social_state_invalid' });

    // A login_request issued for app-b may not be used against app-a.
    const foreign = await transactions.createAuthorizeLoginRequest({
      clientId: 'app-b',
      authorizeUrl: `${issuer}/oauth2/authorize?client_id=app-b&state=${CLIENT_STATE}`,
    });
    await request(app.server)
      .get('/oauth2/social/app-a/google/start')
      .query({ login_request: foreign })
      .expect(400);
  }, 60_000);

  it('activates an invited membership after the provider proved the identity', async () => {
    const email = `invited-${randomUUID()}@app-a.test`;
    const user = await prisma.user.create({
      data: {
        tenantId,
        username: `invited-${randomUUID().slice(0, 8)}`,
        email,
        displayName: 'Invited',
        status: 'active',
      },
      select: { id: true },
    });
    await prisma.clientMembership.create({
      data: { clientId: appAId, userId: user.id, status: 'invited' },
    });
    googleState.profile = profile('google', { email, emailVerified: true });

    const flow = await startFlow('app-a', 'google');
    await callback('app-a', 'google', flow).expect(302);

    expect((await membershipFor(appAId, user.id))?.status).toBe('active');
  }, 60_000);

  it('rejects an unverified identity for a user whose account is disabled', async () => {
    const email = `disabled-${randomUUID()}@app-a.test`;
    const user = await prisma.user.create({
      data: {
        tenantId,
        username: `disabled-${randomUUID().slice(0, 8)}`,
        email,
        displayName: 'Disabled',
        status: 'disabled',
      },
      select: { id: true },
    });
    await prisma.identity.create({
      data: { userId: user.id, provider: 'google', providerUserId: `disabled-${randomUUID()}` },
    });
    const identity = await prisma.identity.findFirstOrThrow({
      where: { userId: user.id },
      select: { providerUserId: true },
    });
    googleState.profile = profile('google', {
      providerUserId: identity.providerUserId,
      email,
    });

    const flow = await startFlow('app-a', 'google');
    const response = await callback('app-a', 'google', flow).expect(302);

    expect(new URL(String(response.headers.location)).searchParams.get('error')).toBe(
      'access_denied',
    );
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  }, 60_000);
});
