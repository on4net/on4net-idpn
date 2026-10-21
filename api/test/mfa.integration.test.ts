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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaAccountProfileRepository } from '../src/account/prisma-account-repository.js';
import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaAdminSessionRepository } from '../src/admin/sessions/prisma-session-repository.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaPasswordStore } from '../src/audit/prisma-audit.js';
import { hashPassword, verifyPassword, type Argon2Params } from '../src/auth/password.js';
import { createSecretBox } from '../src/crypto/secret-box.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPrismaLoginRepository } from '../src/login/prisma-repository.js';
import {
  MFA_CHALLENGE_MAX_ATTEMPTS,
  MemoryMfaChallengeStore,
  RedisMfaChallengeStore,
} from '../src/mfa/challenge-store.js';
import { createPrismaMfaRepository } from '../src/mfa/prisma-repository.js';
import { totpCode } from '../src/mfa/totp.js';
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
): Promise<string> {
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
  return client.id;
}

async function createSession(userId: string, clientId = 'app-a'): Promise<IdpSession> {
  const session = await store.create({
    userId,
    clientId,
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

const sessionCookieFrom = (response: SupertestResponse): string => {
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

/** Enrolls TOTP through the account API and returns the confirmed factor + codes. */
async function enrollTotp(userId: string): Promise<{ factorId: string; recoveryCodes: string[] }> {
  const session = await createSession(userId);
  const start = await request(app.server)
    .post('/api/v1/account/mfa/totp/enroll')
    .set('Cookie', cookie(session))
    .set(sameOrigin)
    .send({ password: userPassword });
  expect(start.status).toBe(201);

  const confirm = await request(app.server)
    .post('/api/v1/account/mfa/totp/verify')
    .set('Cookie', cookie(session))
    .set(sameOrigin)
    .send({ factorId: start.body.factorId, code: totpCode(start.body.secret, Date.now()) });
  expect(confirm.status).toBe(200);
  return { factorId: start.body.factorId, recoveryCodes: confirm.body.recoveryCodes };
}

const secretOf = async (factorId: string): Promise<string> => {
  const envelope = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } });
  return createSecretBox(SECRET_KEY).decrypt(envelope.secretEncrypted ?? new Uint8Array());
};

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

async function verify(challengeToken: string, code: string, method?: 'totp' | 'recovery') {
  return request(app.server)
    .post('/api/v1/login/mfa/verify')
    .send({ challengeToken, code, ...(method === undefined ? {} : { method }) });
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_mfa_${Date.now()}`;
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
      cookie: { secure: true, idleTtlSeconds: 600, absoluteTtlSeconds: 3600 },
    },
    account: {
      sessions: store,
      repository: sessionRepository,
      profiles: createPrismaAccountProfileRepository(prisma),
      passwords: createPrismaPasswordStore(prisma, { sessions: store }),
      audit,
      mfa: {
        repository: mfaRepository,
        secretBox,
        issuer: 'auth.example.com',
        recoveryParams: FAST_ARGON2,
      },
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  tenantId = tenant.id;
  await createClient('app-a', 'optional');
  await createClient('app-required', 'required_all');
  await createClient('app-admins', 'required_admins');
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

describe('account MFA enrollment', () => {
  it('returns the secret once, stores it encrypted and never exposes it again', async () => {
    const userId = await createUser('enroll-user');
    const session = await createSession(userId);

    const start = await request(app.server)
      .post('/api/v1/account/mfa/totp/enroll')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ password: userPassword });
    expect(start.status).toBe(201);
    expect(start.body.otpauthUri).toContain('otpauth://totp/');
    expect(start.body.secret).toMatch(/^[A-Z2-7]{32}$/);

    const stored = await prisma.mfaFactor.findUniqueOrThrow({
      where: { id: start.body.factorId },
    });
    expect(stored.confirmedAt).toBeNull();
    expect(stored.secretEncrypted).not.toBeNull();
    const ciphertext = Buffer.from(stored.secretEncrypted ?? new Uint8Array());
    expect(ciphertext.toString('utf8')).not.toContain(start.body.secret);
    expect(ciphertext.includes(Buffer.from(start.body.secret, 'ascii'))).toBe(false);

    const status = await request(app.server)
      .get('/api/v1/account/mfa')
      .set('Cookie', cookie(session));
    expect(status.status).toBe(200);
    expect(status.body.totp).toMatchObject({ confirmed: false });
    expect(JSON.stringify(status.body)).not.toContain(start.body.secret);
  });

  it('requires the current password before starting enrolment', async () => {
    const userId = await createUser('enroll-password');
    const session = await createSession(userId);

    const missing = await request(app.server)
      .post('/api/v1/account/mfa/totp/enroll')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({});
    expect(missing.status).toBe(422);

    const wrong = await request(app.server)
      .post('/api/v1/account/mfa/totp/enroll')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ password: 'wrong-password-1' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('invalid_current_password');
    // A hijacked session cannot bind an authenticator without the password.
    expect(await prisma.mfaFactor.count({ where: { userId } })).toBe(0);

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'user.mfa.failed', actorId: userId },
    });
    expect(audit?.metadata).toMatchObject({ type: 'totp', stage: 'enroll' });
  });

  it('requires a valid code before confirming and issuing recovery codes', async () => {
    const userId = await createUser('confirm-user');
    const session = await createSession(userId);

    const start = await request(app.server)
      .post('/api/v1/account/mfa/totp/enroll')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ password: userPassword });
    const wrong = await request(app.server)
      .post('/api/v1/account/mfa/totp/verify')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ factorId: start.body.factorId, code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('invalid_mfa_code');

    const confirm = await request(app.server)
      .post('/api/v1/account/mfa/totp/verify')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ factorId: start.body.factorId, code: totpCode(start.body.secret, Date.now()) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);

    const again = await request(app.server)
      .post('/api/v1/account/mfa/totp/enroll')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ password: userPassword });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('totp_already_enrolled');

    const audits = await prisma.auditEvent.findMany({
      where: {
        action: { in: ['user.mfa.enrolled', 'user.mfa.failed'] },
        targetId: start.body.factorId,
      },
    });
    expect(audits.map((event) => event.action).sort()).toEqual([
      'user.mfa.enrolled',
      'user.mfa.failed',
    ]);
    for (const event of audits) {
      const serialized = JSON.stringify(event.metadata);
      expect(serialized).not.toContain(start.body.secret);
      expect(serialized).not.toContain(confirm.body.recoveryCodes[0]);
    }
  });

  it('rejects a cross-origin enrollment attempt', async () => {
    const userId = await createUser('csrf-mfa');
    const session = await createSession(userId);

    const response = await request(app.server)
      .post('/api/v1/account/mfa/totp/enroll')
      .set('Cookie', cookie(session))
      .set('Origin', 'https://evil.example')
      .send({ password: userPassword });
    expect(response.status).toBe(403);
    expect(await prisma.mfaFactor.count({ where: { userId } })).toBe(0);
  });

  it('rotates recovery codes and invalidates the previous set', async () => {
    const userId = await createUser('rotate-recovery');
    const session = await createSession(userId);
    const enrolled = await enrollTotp(userId);

    const wrong = await request(app.server)
      .post('/api/v1/account/mfa/recovery-codes')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ password: 'wrong-password-1' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('invalid_current_password');

    const rotated = await request(app.server)
      .post('/api/v1/account/mfa/recovery-codes')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ password: userPassword });
    expect(rotated.status).toBe(200);
    expect(rotated.body.recoveryCodes).toHaveLength(10);

    // The old codes are gone: the login challenge refuses them.
    const challenge = await login('rotate-recovery', 'app-a');
    const oldCode = enrolled.recoveryCodes[0] ?? '';
    const rejected = await verify(challenge.body.challengeToken, oldCode, 'recovery');
    expect(rejected.status).toBe(401);

    // A new code works and is consumed.
    const fresh = rotated.body.recoveryCodes[0] ?? '';
    const accepted = await verify(challenge.body.challengeToken, fresh, 'recovery');
    expect(accepted.status).toBe(200);
  });

  it('disables TOTP with the current password and audits the removal', async () => {
    const userId = await createUser('disable-user');
    const session = await createSession(userId);
    const enrolled = await enrollTotp(userId);

    const wrong = await request(app.server)
      .post('/api/v1/account/mfa/totp/disable')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ password: 'wrong-password-1' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('invalid_current_password');
    expect(await prisma.mfaFactor.count({ where: { userId } })).toBe(1);

    const disabled = await request(app.server)
      .post('/api/v1/account/mfa/totp/disable')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ password: userPassword });
    expect(disabled.status).toBe(200);
    expect(disabled.body).toEqual({ ok: true });
    expect(await prisma.mfaFactor.count({ where: { userId } })).toBe(0);
    expect(await prisma.mfaRecoveryCode.count({ where: { factorId: enrolled.factorId } })).toBe(0);

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'user.mfa.removed', targetId: enrolled.factorId },
    });
    expect(audit?.result).toBe('success');
  });
});

describe('login with TOTP', () => {
  it('returns a challenge instead of a session and completes after a valid code', async () => {
    const userId = await createUser('login-totp');
    const enrolled = await enrollTotp(userId);
    const secret = await secretOf(enrolled.factorId);

    const challenge = await login('login-totp', 'app-a');
    expect(challenge.status).toBe(200);
    expect(challenge.headers['set-cookie']).toBeUndefined();
    expect(challenge.body).toMatchObject({
      ok: false,
      mfa: 'challenge',
      methods: ['totp', 'recovery'],
    });

    const verified = await verify(
      challenge.body.challengeToken,
      totpCode(secret, Date.now()),
      'totp',
    );
    expect(verified.status).toBe(200);
    expect(verified.body.ok).toBe(true);

    const sid = sessionCookieFrom(verified);
    const session = await store.read(sid);
    expect(session).not.toBeNull();
    expect(session?.amr).toEqual(['pwd', 'totp']);
    expect(session?.acr).toBe('urn:on4net:acr:mfa');
    const mirror = await prisma.session.findUniqueOrThrow({ where: { id: sid } });
    expect(mirror.amr).toEqual(['pwd', 'totp']);
    expect(mirror.acr).toBe('urn:on4net:acr:mfa');
  });

  it('rejects a wrong code, counts attempts and rate-limits the challenge', async () => {
    const userId = await createUser('login-wrong');
    await enrollTotp(userId);

    const challenge = await login('login-wrong', 'app-a');
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await verify(challenge.body.challengeToken, '000000', 'totp');
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('invalid_mfa_code');
    }
    const limited = await verify(challenge.body.challengeToken, '000000', 'totp');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('mfa_rate_limited');

    // The challenge is destroyed: even the correct code cannot complete it afterwards.
    const afterLimit = await verify(challenge.body.challengeToken, '000000', 'totp');
    expect(afterLimit.status).toBe(401);

    const audits = await prisma.auditEvent.findMany({
      where: { action: 'user.mfa.failed', actorId: userId },
    });
    expect(audits.length).toBeGreaterThanOrEqual(5);
    for (const event of audits) {
      expect(JSON.stringify(event.metadata)).not.toContain('000000');
    }
  });

  it('does not let concurrent guesses spend the budget more than once', async () => {
    const userId = await createUser('login-concurrent');
    await enrollTotp(userId);
    const challenge = await login('login-concurrent', 'app-a');

    const responses = await Promise.all(
      Array.from({ length: MFA_CHALLENGE_MAX_ATTEMPTS * 2 }, () =>
        verify(challenge.body.challengeToken, '000000', 'totp'),
      ),
    );

    // Only a reserved attempt may reach the verifier, so exactly the budget is spent no
    // matter how many requests arrive at once.
    const audited = await prisma.auditEvent.count({
      where: { action: 'user.mfa.failed', actorId: userId },
    });
    expect(audited).toBe(MFA_CHALLENGE_MAX_ATTEMPTS);
    expect(responses.some((response) => response.status === 429)).toBe(true);
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(0);
  });

  it('locks the account after repeated wrong MFA codes', async () => {
    const userId = await createUser('login-lockout');
    await enrollTotp(userId);
    const challenge = await login('login-lockout', 'app-a');

    for (let attempt = 1; attempt <= MFA_CHALLENGE_MAX_ATTEMPTS; attempt += 1) {
      await verify(challenge.body.challengeToken, '000000', 'totp');
    }

    const locked = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(locked.lockedUntil).not.toBeNull();
    expect(locked.lockedUntil?.getTime() ?? 0).toBeGreaterThan(Date.now());

    // The password branch honours the same lock, so the account is not left half-protected.
    const fresh = await login('login-lockout', 'app-a');
    expect(fresh.status).toBe(401);
  });

  it('rejects a replayed TOTP step even with a fresh challenge', async () => {
    const userId = await createUser('login-replay');
    const enrolled = await enrollTotp(userId);
    const secret = await secretOf(enrolled.factorId);
    const code = totpCode(secret, Date.now());

    const first = await login('login-replay', 'app-a');
    expect((await verify(first.body.challengeToken, code, 'totp')).status).toBe(200);

    const second = await login('login-replay', 'app-a');
    const replayed = await verify(second.body.challengeToken, code, 'totp');
    expect(replayed.status).toBe(401);
    expect(replayed.body.error).toBe('invalid_mfa_code');
  });

  it('consumes a recovery code once and marks the session amr', async () => {
    const userId = await createUser('login-recovery');
    const enrolled = await enrollTotp(userId);
    const code = enrolled.recoveryCodes[0] ?? '';

    const first = await login('login-recovery', 'app-a');
    const accepted = await verify(first.body.challengeToken, code, 'recovery');
    expect(accepted.status).toBe(200);
    const session = await store.read(sessionCookieFrom(accepted));
    expect(session?.amr).toEqual(['pwd', 'recovery']);

    const second = await login('login-recovery', 'app-a');
    const replayed = await verify(second.body.challengeToken, code, 'recovery');
    expect(replayed.status).toBe(401);
  });

  it('rejects an unknown or expired challenge token', async () => {
    const response = await verify('A'.repeat(43), '123456', 'totp');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('mfa_challenge_invalid');

    const malformed = await request(app.server)
      .post('/api/v1/login/mfa/verify')
      .send({ challengeToken: 'x', code: '' });
    expect(malformed.status).toBe(400);
  });

  it('rejects a challenge once it expired', async () => {
    const userId = await createUser('login-expired');
    const enrolled = await enrollTotp(userId);
    const secret = await secretOf(enrolled.factorId);

    let clock = Date.now();
    const challenges = new MemoryMfaChallengeStore({ now: () => clock });
    const challenge = await challenges.create({ userId, tenantId, clientId: 'app-a' });
    clock += 301_000;

    const keys = new SigningKeyManager(new MemorySigningKeyRepository());
    await keys.ensureKey();
    const loginRepository = createPrismaLoginRepository(prisma);
    const mfaRepository = createPrismaMfaRepository(prisma);
    const expiredApp = buildServer({
      issuer,
      keys,
      login: {
        users: loginRepository,
        sessions: store,
        persistSession: (input) => loginRepository.persistSession(input),
        audit: { record: (event) => loginRepository.record(event) },
        mfa: {
          repository: mfaRepository,
          challenges,
          secretBox: createSecretBox(SECRET_KEY),
          verify: (hash, value) => verifyPassword(hash, value, FAST_ARGON2),
          recoveryParams: FAST_ARGON2,
        },
        cookie: { secure: true, idleTtlSeconds: 600, absoluteTtlSeconds: 3600 },
      },
    });
    await expiredApp.ready();
    try {
      const response = await request(expiredApp.server)
        .post('/api/v1/login/mfa/verify')
        .send({
          challengeToken: challenge.token,
          code: totpCode(secret, Date.now()),
          method: 'totp',
        });
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('mfa_challenge_invalid');
    } finally {
      await expiredApp.close();
    }
  });
});

describe('login MFA policy matrix', () => {
  it('does not challenge an optional client when no factor is enrolled', async () => {
    await createUser('optional-none');
    const response = await login('optional-none', 'app-a');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.headers['set-cookie']).toBeDefined();
  });

  it('refuses a session under required_all when no factor is enrolled', async () => {
    const userId = await createUser('required-none');
    const response = await login('required-none', 'app-required');
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('mfa_enrollment_required');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(
      await prisma.auditEvent.count({
        where: { action: 'user.login.mfa_enrollment_required', actorId: userId },
      }),
    ).toBe(1);
  });

  it('applies the login-context policy instead of the client policy', async () => {
    await createUser('context-policy');
    const client = await prisma.client.findUniqueOrThrow({ where: { clientId: 'app-a' } });
    await prisma.clientLoginContext.create({
      data: {
        clientId: client.id,
        key: 'strict',
        name: 'Strict',
        allowedRoles: [],
        defaultRoles: [],
        loginMethods: ['password'],
        mfaPolicy: 'required_all',
        allowedEmailDomains: [],
        sessionIdleTtl: 600,
        sessionAbsoluteTtl: 3600,
      },
    });

    const strict = await login('context-policy', 'app-a', 'strict');
    expect(strict.status).toBe(403);
    expect(strict.body.error).toBe('mfa_enrollment_required');

    const relaxed = await login('context-policy', 'app-a');
    expect(relaxed.status).toBe(200);
  });

  it('requires MFA for admins only under required_admins', async () => {
    const adminId = await createUser('admin-user');
    const memberId = await createUser('member-user');
    const permission = await prisma.permission.create({
      data: {
        key: `idp:test:mfa-admin:${randomUUID().slice(0, 8)}`,
        description: 'MFA admin test permission',
      },
    });
    const role = await prisma.role.create({
      data: {
        key: `mfa-admin-${randomUUID().slice(0, 8)}`,
        name: 'MFA admin',
        description: 'MFA admin test role',
      },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    await prisma.assignment.create({
      data: {
        roleId: role.id,
        subjectType: 'user',
        subjectId: adminId,
        scopeType: 'global',
        assignedBy: adminId,
      },
    });

    const admin = await login('admin-user', 'app-admins');
    expect(admin.status).toBe(403);
    expect(admin.body.error).toBe('mfa_enrollment_required');

    const member = await login('member-user', 'app-admins');
    expect(member.status).toBe(200);
    expect(
      await prisma.auditEvent.count({
        where: { action: 'user.login.mfa_enrollment_required', actorId: memberId },
      }),
    ).toBe(0);
  });
});
