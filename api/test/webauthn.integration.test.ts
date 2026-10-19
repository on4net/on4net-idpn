import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import request, { type Response as SupertestResponse } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaAccountProfileRepository } from '../src/account/prisma-account-repository.js';
import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaAdminSessionRepository } from '../src/admin/sessions/prisma-session-repository.js';
import { createPrismaPasswordStore } from '../src/audit/prisma-audit.js';
import { hashPassword, verifyPassword, type Argon2Params } from '../src/auth/password.js';
import { createSecretBox } from '../src/crypto/secret-box.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPrismaLoginRepository } from '../src/login/prisma-repository.js';
import { RedisMfaChallengeStore } from '../src/mfa/challenge-store.js';
import { createPrismaMfaRepository } from '../src/mfa/prisma-repository.js';
import { RedisWebauthnChallengeStore } from '../src/mfa/webauthn-challenge-store.js';
import type { WebauthnLibrary } from '../src/mfa/webauthn-library.js';
import { resolveWebauthnConfig } from '../src/mfa/webauthn.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { buildServer } from '../src/server.js';
import { RedisSessionCache } from '../src/session/redis-cache.js';
import { RedisSessionStore } from '../src/session/store.js';
import type { IdpSession } from '../src/session/types.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3100';
const userPassword = 'user-password-123';
const FAST_ARGON2: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const SECRET_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

let container: StartedPostgreSqlContainer | undefined;
let redisContainer: StartedRedisContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let redis: Redis;
let prisma: PrismaClient;
let store: RedisSessionStore;
let app: ReturnType<typeof buildServer>;
let tenantId: string;

/** Mutable counter returned by the injected verifier; tests set it per assertion. */
let nextCounter = 1;

const fakeLibrary: WebauthnLibrary = {
  async generateRegistrationOptions(input) {
    const challenge = randomBytes(32).toString('base64url');
    return {
      options: {
        rp: { id: input.rpId, name: input.rpName },
        user: { id: 'dXNlcg', name: input.userName, displayName: input.userDisplayName ?? '' },
        challenge,
        pubKeyCredParams: [],
        timeout: 60_000,
      },
      challenge,
    } as never;
  },
  async generateAuthenticationOptions(input) {
    const challenge = randomBytes(32).toString('base64url');
    return {
      options: {
        challenge,
        rpId: input.rpId,
        allowCredentials: input.allowCredentials.map((credential) => ({
          type: 'public-key',
          id: credential.id,
          ...(credential.transports === undefined ? {} : { transports: credential.transports }),
        })),
        userVerification: input.userVerification,
      },
      challenge,
    };
  },
  async verifyRegistration(input) {
    const response = input.response as { id: string; response?: { transports?: string[] } };
    return {
      verified: true,
      value: {
        id: response.id,
        publicKey: new Uint8Array([1, 2, 3, 4, 5]),
        counter: 0,
        transports: response.response?.transports ?? ['internal'],
        aaguid: null,
        deviceType: 'multiDevice',
        backedUp: true,
      },
    };
  },
  async verifyAuthentication(_input) {
    return {
      verified: true,
      value: { newCounter: nextCounter },
    };
  },
};

const connectionString = (): string => connectionStringValue;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

async function createUser(username: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      tenantId,
      username,
      email: `${username}@example.com`,
      displayName: `Display ${username}`,
      status: 'active',
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(userPassword, FAST_ARGON2),
    },
  });
  return user.id;
}

async function createClient(
  clientId: string,
  policy: 'optional' | 'required_admins' | 'required_all' = 'optional',
  loginContexts: { key: string; stepUpRequired: boolean }[] = [],
): Promise<void> {
  const client = await prisma.client.create({
    data: {
      clientId,
      name: clientId,
      type: 'web',
      redirectUris: ['https://app.example.com/callback'],
      postLogoutRedirectUris: [],
      allowedOrigins: [],
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      mfaPolicy: policy,
      tenantId,
    },
  });
  for (const context of loginContexts) {
    await prisma.clientLoginContext.create({
      data: {
        clientId: client.id,
        key: context.key,
        name: context.key,
        allowedRoles: [],
        defaultRoles: [],
        loginMethods: ['password'],
        mfaPolicy: policy,
        registrationPolicy: 'invite_only',
        allowedEmailDomains: [],
        sessionIdleTtl: 1800,
        sessionAbsoluteTtl: 28_800,
        stepUpRequired: context.stepUpRequired,
      },
    });
  }
}

async function createSession(userId: string): Promise<IdpSession> {
  const session = await store.create({
    userId,
    clientId: 'app-a',
    amr: ['pwd'],
    acr: 'urn:on4net:acr:pwd',
    ip: '10.0.0.1',
    userAgent: 'vitest-agent',
  });
  await prisma.session.create({
    data: {
      id: session.sid,
      userId,
      clientId: null,
      createdAt: new Date(session.createdAt),
      lastSeenAt: new Date(session.lastSeenAt),
      idleExpiresAt: new Date(session.idleExpiresAt),
      absoluteExpiresAt: new Date(session.absoluteExpiresAt),
      ip: session.ip ?? null,
      userAgent: session.userAgent ?? null,
      amr: session.amr,
      acr: session.acr,
    },
  });
  return session;
}

const cookie = (session: IdpSession): string => `idpn_session=${session.sid}`;
const sameOrigin = { Origin: issuer };

const cookieFrom = (response: SupertestResponse): string => {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : [header];
  const match = values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => /idpn_session=([^;]+)/.exec(value)?.[1])
    .find((value) => value !== undefined);
  if (match === undefined) {
    throw new Error('no session cookie in response');
  }
  return match;
};

const clientData = (
  type: 'webauthn.create' | 'webauthn.get',
  challenge: string,
  origin = issuer,
): string =>
  Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString(
    'base64url',
  );

async function startRegistration(session: IdpSession): Promise<{
  challengeId: string;
  challenge: string;
}> {
  const response = await request(app.server)
    .post('/api/v1/account/mfa/webauthn/options')
    .set('Cookie', cookie(session))
    .set(sameOrigin)
    .send({});
  expect(response.status).toBe(200);
  return { challengeId: response.body.challengeId, challenge: response.body.options.challenge };
}

async function enrollPasskey(
  userId: string,
  credentialId = randomBytes(16).toString('base64url'),
  name = 'Laptop',
  origin = issuer,
): Promise<{ factorId: string; credentialId: string; session: IdpSession }> {
  const session = await createSession(userId);
  const started = await startRegistration(session);
  const response = await request(app.server)
    .post('/api/v1/account/mfa/webauthn/verify')
    .set('Cookie', cookie(session))
    .set(sameOrigin)
    .send({
      challengeId: started.challengeId,
      name,
      response: {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: clientData('webauthn.create', started.challenge, origin),
          transports: ['internal', 'hybrid'],
        },
        clientExtensionResults: {},
      },
    });
  expect(response.status).toBe(201);
  return { factorId: response.body.factor.id, credentialId, session };
}

async function login(identifier: string, clientId: string, loginContext?: string) {
  return request(app.server)
    .post('/api/v1/login')
    .send({
      identifier,
      password: userPassword,
      clientId,
      ...(loginContext === undefined ? {} : { loginContext }),
    });
}

async function loginWithPasskey(
  identifier: string,
  clientId: string,
  credentialId: string,
  options: { counter?: number; loginContext?: string } = {},
) {
  nextCounter = options.counter ?? 1;
  const passwordStep = await login(identifier, clientId, options.loginContext);
  expect(passwordStep.status).toBe(200);
  expect(passwordStep.body.mfa).toBe('challenge');
  expect(passwordStep.body.methods).toContain('webauthn');

  const optionsResponse = await request(app.server)
    .post('/api/v1/login/mfa/webauthn/options')
    .send({ challengeToken: passwordStep.body.challengeToken });
  expect(optionsResponse.status).toBe(200);

  const verified = await request(app.server)
    .post('/api/v1/login/mfa/webauthn/verify')
    .send({
      challengeToken: passwordStep.body.challengeToken,
      challengeId: optionsResponse.body.challengeId,
      response: {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: clientData('webauthn.get', optionsResponse.body.options.challenge),
        },
        clientExtensionResults: {},
      },
    });
  return { verified, passwordStep, optionsResponse };
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_webauthn_${Date.now()}`;
    serverClient = new Client({ connectionString: external });
    await serverClient.connect();
    await serverClient.query(`CREATE DATABASE "${scratchDatabase}"`);
    const url = new URL(external);
    url.pathname = `/${scratchDatabase}`;
    connectionStringValue = url.toString();
  } else {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(180_000)
      .start();
    connectionStringValue = container.getConnectionUri();
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
  store = new RedisSessionStore({
    cache: new RedisSessionCache(redis),
    policy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600, maxConcurrentSessions: 0 },
  });

  const keys = new SigningKeyManager(new MemorySigningKeyRepository());
  await keys.ensureKey();
  const sessionRepository = createPrismaAdminSessionRepository(prisma);
  const audit = createPrismaAdminAudit(prisma);
  const permissionReader = createPrismaPermissionReader(prisma);
  const loginRepository = createPrismaLoginRepository(prisma);
  const mfaRepository = createPrismaMfaRepository(prisma, { permissions: permissionReader });
  const secretBox = createSecretBox(SECRET_KEY);
  const webauthn = {
    config: resolveWebauthnConfig({ appUrl: issuer, rpName: 'on4net' }),
    challenges: new RedisWebauthnChallengeStore(redis),
    repository: mfaRepository,
    library: fakeLibrary,
  };

  app = buildServer({
    issuer,
    keys,
    login: {
      users: loginRepository,
      sessions: store,
      persistSession: (input) => loginRepository.persistSession(input),
      audit: { record: (event) => loginRepository.record(event) },
      mfa: {
        repository: mfaRepository,
        challenges: new RedisMfaChallengeStore(redis),
        secretBox,
        verify: (hash, value) => verifyPassword(hash, value, FAST_ARGON2),
        recoveryParams: FAST_ARGON2,
      },
      webauthn,
      cookie: { secure: true, idleTtlSeconds: 600, absoluteTtlSeconds: 3600 },
    },
    account: {
      sessions: store,
      repository: sessionRepository,
      persistSession: (input) => loginRepository.persistSession(input),
      profiles: createPrismaAccountProfileRepository(prisma),
      passwords: createPrismaPasswordStore(prisma, { sessions: store }),
      audit,
      mfa: {
        repository: mfaRepository,
        secretBox,
        issuer: 'auth.example.com',
        recoveryParams: FAST_ARGON2,
      },
      webauthn,
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  tenantId = tenant.id;
  await createClient('app-a', 'optional');
  await createClient('app-required', 'required_all');
  await createClient('app-stepup', 'optional', [{ key: 'sensitive', stepUpRequired: true }]);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await redis?.quit();
  await redisContainer?.stop();
  await prisma?.$disconnect();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

describe('passkey enrollment', () => {
  it('registers a credential once, lists it and stores only public material', async () => {
    const userId = await createUser('passkey-enroll');
    const credentialId = randomBytes(16).toString('base64url');
    const enrolled = await enrollPasskey(userId, credentialId, 'Office key');

    const stored = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: enrolled.factorId } });
    expect(stored.type).toBe('webauthn');
    expect(stored.name).toBe('Office key');
    expect(Buffer.from(stored.credentialId ?? new Uint8Array()).toString('base64url')).toBe(
      credentialId,
    );
    expect(stored.publicKey).not.toBeNull();
    expect(stored.signCount).toBe(0n);
    expect(stored.transports).toEqual(['internal', 'hybrid']);
    expect(stored.confirmedAt).not.toBeNull();

    const status = await request(app.server)
      .get('/api/v1/account/mfa')
      .set('Cookie', cookie(enrolled.session));
    expect(status.status).toBe(200);
    expect(status.body.webauthn).toHaveLength(1);
    expect(status.body.webauthn[0]).toMatchObject({
      name: 'Office key',
      confirmed: true,
      transports: ['internal', 'hybrid'],
      backedUp: true,
    });
    expect(JSON.stringify(status.body)).not.toContain(
      Buffer.from(stored.publicKey ?? new Uint8Array()).toString('base64'),
    );
  });

  it('rejects a duplicate credential across users and a replayed ceremony', async () => {
    const first = await createUser('passkey-duplicate-a');
    const second = await createUser('passkey-duplicate-b');
    const credentialId = randomBytes(16).toString('base64url');
    await enrollPasskey(first, credentialId);

    const session = await createSession(second);
    const started = await startRegistration(session);
    const duplicate = await request(app.server)
      .post('/api/v1/account/mfa/webauthn/verify')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({
        challengeId: started.challengeId,
        response: {
          id: credentialId,
          rawId: credentialId,
          type: 'public-key',
          response: { clientDataJSON: clientData('webauthn.create', started.challenge) },
          clientExtensionResults: {},
        },
      });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('webauthn_credential_exists');

    const replay = await request(app.server)
      .post('/api/v1/account/mfa/webauthn/verify')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({
        challengeId: started.challengeId,
        response: {
          id: randomBytes(16).toString('base64url'),
          rawId: randomBytes(16).toString('base64url'),
          type: 'public-key',
          response: { clientDataJSON: clientData('webauthn.create', started.challenge) },
          clientExtensionResults: {},
        },
      });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('webauthn_challenge_invalid');
  });

  it('rejects an assertion from a foreign origin without persisting a factor', async () => {
    const userId = await createUser('passkey-origin');
    const session = await createSession(userId);
    const started = await startRegistration(session);
    const response = await request(app.server)
      .post('/api/v1/account/mfa/webauthn/verify')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({
        challengeId: started.challengeId,
        response: {
          id: randomBytes(16).toString('base64url'),
          rawId: randomBytes(16).toString('base64url'),
          type: 'public-key',
          response: {
            clientDataJSON: clientData(
              'webauthn.create',
              started.challenge,
              'https://evil.example.net',
            ),
          },
          clientExtensionResults: {},
        },
      });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('webauthn_origin_not_allowed');
    expect(await prisma.mfaFactor.count({ where: { userId, type: 'webauthn' } })).toBe(0);
  });

  it('renames and deletes a passkey scoped to the owning user', async () => {
    const owner = await createUser('passkey-owner');
    const other = await createUser('passkey-other');
    const enrolled = await enrollPasskey(owner, randomBytes(16).toString('base64url'), 'Old name');
    const otherSession = await createSession(other);

    const foreignDelete = await request(app.server)
      .delete(`/api/v1/account/mfa/webauthn/${enrolled.factorId}`)
      .set('Cookie', cookie(otherSession))
      .set(sameOrigin);
    expect(foreignDelete.status).toBe(404);

    const renamed = await request(app.server)
      .patch(`/api/v1/account/mfa/webauthn/${enrolled.factorId}`)
      .set('Cookie', cookie(enrolled.session))
      .set(sameOrigin)
      .send({ name: 'New name' });
    expect(renamed.status).toBe(200);

    const deleted = await request(app.server)
      .delete(`/api/v1/account/mfa/webauthn/${enrolled.factorId}`)
      .set('Cookie', cookie(enrolled.session))
      .set(sameOrigin);
    expect(deleted.status).toBe(200);
    expect(await prisma.mfaFactor.count({ where: { id: enrolled.factorId } })).toBe(0);
  });
});

describe('passkey login and MFA policy', () => {
  it('completes a password login with a passkey and issues an MFA session', async () => {
    const userId = await createUser('passkey-login');
    const enrolled = await enrollPasskey(userId);

    const { verified } = await loginWithPasskey('passkey-login', 'app-a', enrolled.credentialId);
    expect(verified.status).toBe(200);
    const sid = cookieFrom(verified);
    const session = await store.read(sid);
    expect(session).not.toBeNull();
    expect(session?.amr).toEqual(['pwd', 'webauthn', 'hwk']);
    expect(session?.acr).toBe('urn:on4net:acr:mfa');
    expect(session?.authTime).toBeDefined();

    const mirror = await prisma.session.findUniqueOrThrow({ where: { id: sid } });
    expect(mirror.amr).toEqual(['pwd', 'webauthn', 'hwk']);
    expect(mirror.acr).toBe('urn:on4net:acr:mfa');

    const stored = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: enrolled.factorId } });
    expect(stored.signCount).toBe(1n);
  });

  it('rejects a replayed assertion whose counter does not advance', async () => {
    const userId = await createUser('passkey-counter');
    const enrolled = await enrollPasskey(userId);

    const first = await loginWithPasskey('passkey-counter', 'app-a', enrolled.credentialId, {
      counter: 4,
    });
    expect(first.verified.status).toBe(200);

    const second = await loginWithPasskey('passkey-counter', 'app-a', enrolled.credentialId, {
      counter: 4,
    });
    expect(second.verified.status).toBe(401);
    expect(second.verified.body.error).toBe('invalid_mfa_code');

    const stored = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: enrolled.factorId } });
    expect(stored.signCount).toBe(4n);
  });

  it('requires MFA for a stepUpRequired login context even when the client policy is optional', async () => {
    const withPasskey = await createUser('passkey-stepup');
    await enrollPasskey(withPasskey);
    const allowed = await login('passkey-stepup', 'app-stepup', 'sensitive');
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ ok: false, mfa: 'challenge' });
    expect(allowed.headers['set-cookie']).toBeUndefined();

    await createUser('passkey-stepup-nofactor');
    const denied = await login('passkey-stepup-nofactor', 'app-stepup', 'sensitive');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('mfa_enrollment_required');
    expect(denied.headers['set-cookie']).toBeUndefined();
  });

  it('does not issue a session when the authentication challenge is reused', async () => {
    const userId = await createUser('passkey-replay');
    const enrolled = await enrollPasskey(userId);
    const passwordStep = await login('passkey-replay', 'app-a');
    const optionsResponse = await request(app.server)
      .post('/api/v1/login/mfa/webauthn/options')
      .send({ challengeToken: passwordStep.body.challengeToken });
    const body = {
      challengeToken: passwordStep.body.challengeToken,
      challengeId: optionsResponse.body.challengeId,
      response: {
        id: enrolled.credentialId,
        rawId: enrolled.credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: clientData('webauthn.get', optionsResponse.body.options.challenge),
        },
        clientExtensionResults: {},
      },
    };
    const first = await request(app.server).post('/api/v1/login/mfa/webauthn/verify').send(body);
    expect(first.status).toBe(200);
    nextCounter = 5;
    const replay = await request(app.server).post('/api/v1/login/mfa/webauthn/verify').send(body);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('mfa_challenge_invalid');
  });
});

describe('step-up', () => {
  it('upgrades a password-only session to MFA with a passkey and rotates the sid', async () => {
    const userId = await createUser('passkey-stepup-session');
    const enrolled = await enrollPasskey(userId);
    const session = enrolled.session;
    nextCounter = 2;

    const optionsResponse = await request(app.server)
      .post('/api/v1/account/mfa/webauthn/authenticate/options')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({});
    expect(optionsResponse.status).toBe(200);

    const verified = await request(app.server)
      .post('/api/v1/account/mfa/webauthn/authenticate/verify')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({
        challengeId: optionsResponse.body.challengeId,
        response: {
          id: enrolled.credentialId,
          rawId: enrolled.credentialId,
          type: 'public-key',
          response: {
            clientDataJSON: clientData('webauthn.get', optionsResponse.body.options.challenge),
          },
          clientExtensionResults: {},
        },
      });
    expect(verified.status).toBe(200);
    expect(verified.body.acr).toBe('urn:on4net:acr:mfa');
    expect(verified.body.amr).toContain('webauthn');

    const rotated = cookieFrom(verified);
    expect(rotated).not.toBe(session.sid);
    expect(await store.read(session.sid)).toBeNull();
    const upgraded = await store.read(rotated);
    expect(upgraded?.amr).toEqual(['pwd', 'webauthn', 'hwk']);
    expect(upgraded?.acr).toBe('urn:on4net:acr:mfa');

    const profile = await request(app.server)
      .get('/api/v1/account/profile')
      .set('Cookie', cookie({ ...session, sid: rotated }));
    expect(profile.status).toBe(200);
  });

  it('refuses step-up for an account without a passkey and for an unauthenticated request', async () => {
    const userId = await createUser('passkey-stepup-none');
    const session = await createSession(userId);
    const noPasskey = await request(app.server)
      .post('/api/v1/account/mfa/webauthn/authenticate/options')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({});
    expect(noPasskey.status).toBe(409);
    expect(noPasskey.body.code).toBe('webauthn_not_enrolled');

    const anonymous = await request(app.server)
      .post('/api/v1/account/mfa/webauthn/authenticate/options')
      .set(sameOrigin)
      .send({});
    expect(anonymous.status).toBe(401);
  });

  it('rejects a cross-site step-up request (cookie-authenticated CSRF guard)', async () => {
    const userId = await createUser('passkey-stepup-csrf');
    const enrolled = await enrollPasskey(userId);
    const response = await request(app.server)
      .post('/api/v1/account/mfa/webauthn/authenticate/options')
      .set('Cookie', cookie(enrolled.session))
      .set('Origin', 'https://evil.example.net')
      .send({});
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('cross_origin_request');
  });
});
