import request, { type Response as SupertestResponse } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaAccountProfileRepository } from '../src/account/prisma-account-repository.js';
import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaAdminSessionRepository } from '../src/admin/sessions/prisma-session-repository.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaPasswordStore } from '../src/audit/prisma-audit.js';
import { hashPassword, verifyPassword, type Argon2Params } from '../src/auth/password.js';
import { createSecretBox } from '../src/crypto/secret-box.js';
import { createPrismaLoginRepository } from '../src/login/prisma-repository.js';
import { RedisMfaChallengeStore } from '../src/mfa/challenge-store.js';
import { createPrismaMfaRepository } from '../src/mfa/prisma-repository.js';
import { totpCode } from '../src/mfa/totp.js';
import { buildServer } from '../src/server.js';
import { RedisSessionCache } from '../src/session/redis-cache.js';
import { RedisSessionStore } from '../src/session/store.js';
import type { IdpSession } from '../src/session/types.js';
import { startPhase4Infra, type Phase4Infra } from './phase4-harness.js';

/**
 * Phase-4 MFA regression edges (docs/testing.md INT-CTX-* and docs/auth-flows.md 7).
 *
 * Complements `mfa.integration.test.ts`: the policy matrix with a *confirmed* factor, the
 * reverse login-context override, challenge/user binding, and single-use guarantees under
 * two concurrent challenges. No assertion from the feature-card suite is repeated verbatim.
 */

const issuer = 'http://127.0.0.1:3410';
const userPassword = 'regression-password-123';
const FAST_ARGON2: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const SECRET_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const MFA_ACR = 'urn:on4net:acr:mfa';

let infra: Phase4Infra;
let store: RedisSessionStore;
let app: ReturnType<typeof buildServer>;
let tenantId: string;
let adminUserId: string;
let sequence = 0;

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

async function createUser(label: string): Promise<{ id: string; username: string }> {
  sequence += 1;
  const username = `${label}-${sequence}-${Date.now()}`;
  const user = await infra.prisma.user.create({
    data: {
      tenantId,
      username,
      email: `${username}@example.com`,
      displayName: `User ${label}`,
      status: 'active',
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(userPassword, FAST_ARGON2),
    },
  });
  return { id: user.id, username };
}

async function createClient(
  clientId: string,
  policy: 'optional' | 'required_admins' | 'required_all',
): Promise<string> {
  const client = await infra.prisma.client.create({
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

async function createSession(userId: string, clientId = 'app-optional'): Promise<IdpSession> {
  const session = await store.create({
    userId,
    clientId,
    amr: ['pwd'],
    acr: 'urn:on4net:acr:pwd',
    ip: '10.0.0.1',
    userAgent: 'vitest-agent',
  });
  await infra.prisma.session.create({
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

async function enrollTotp(
  userId: string,
): Promise<{ factorId: string; secret: string; recoveryCodes: string[] }> {
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
  return {
    factorId: start.body.factorId,
    secret: start.body.secret,
    recoveryCodes: confirm.body.recoveryCodes,
  };
}

const login = (identifier: string, clientId: string, loginContext?: string) =>
  request(app.server)
    .post('/api/v1/login')
    .send({
      identifier,
      password: userPassword,
      clientId,
      ...(loginContext === undefined ? {} : { loginContext }),
    });

const verify = (challengeToken: string, code: string, method?: 'totp' | 'recovery') =>
  request(app.server)
    .post('/api/v1/login/mfa/verify')
    .send({ challengeToken, code, ...(method === undefined ? {} : { method }) });

beforeAll(async () => {
  infra = await startPhase4Infra('idpn_phase4_mfa');
  tenantId = infra.tenantId;
  store = new RedisSessionStore({
    cache: new RedisSessionCache(infra.redis),
    policy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600, maxConcurrentSessions: 0 },
  });

  const audit = createPrismaAdminAudit(infra.prisma);
  const permissionReader = createPrismaPermissionReader(infra.prisma);
  const loginRepository = createPrismaLoginRepository(infra.prisma);
  const mfaRepository = createPrismaMfaRepository(infra.prisma, {
    permissions: permissionReader,
  });
  const secretBox = createSecretBox(SECRET_KEY);

  app = buildServer({
    issuer,
    keys: infra.keys,
    login: {
      users: loginRepository,
      sessions: store,
      persistSession: (input) => loginRepository.persistSession(input),
      audit: { record: (event) => loginRepository.record(event) },
      mfa: {
        repository: mfaRepository,
        challenges: new RedisMfaChallengeStore(infra.redis),
        secretBox,
        verify: (hash, value) => verifyPassword(hash, value, FAST_ARGON2),
        recoveryParams: FAST_ARGON2,
      },
      cookie: { secure: true, idleTtlSeconds: 600, absoluteTtlSeconds: 3600 },
    },
    account: {
      sessions: store,
      repository: createPrismaAdminSessionRepository(infra.prisma),
      profiles: createPrismaAccountProfileRepository(infra.prisma),
      passwords: createPrismaPasswordStore(infra.prisma, { sessions: store }),
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

  const optional = await createClient('app-optional', 'optional');
  const required = await createClient('app-required', 'required_all');
  await createClient('app-admins', 'required_admins');

  const newContext = (
    clientId: string,
    key: string,
    policy: 'optional' | 'required_all',
    stepUpRequired = false,
  ) =>
    infra.prisma.clientLoginContext.create({
      data: {
        clientId,
        key,
        name: key,
        allowedRoles: [],
        defaultRoles: [],
        loginMethods: ['password'],
        mfaPolicy: policy,
        allowedEmailDomains: [],
        sessionIdleTtl: 600,
        sessionAbsoluteTtl: 3600,
        stepUpRequired,
      },
    });

  // A relaxed context on a required client proves the context wins over the client policy.
  await newContext(required, 'relaxed', 'optional');
  // A strict context on an optional client proves the reverse direction.
  await newContext(optional, 'strict', 'required_all');

  // Global permission so `required_admins` can recognise an administrator.
  const permission = await infra.prisma.permission.create({
    data: {
      key: `idp:test:mfa-regression:${Date.now()}`,
      description: 'MFA regression admin marker',
    },
  });
  const role = await infra.prisma.role.create({
    data: {
      key: `mfa-regression-admin-${Date.now()}`,
      name: 'MFA regression admin',
      description: 'MFA regression admin role',
      rolePermissions: { create: [{ permissionId: permission.id }] },
    },
  });
  const admin = await createUser('mfa-admin');
  await infra.prisma.assignment.create({
    data: {
      roleId: role.id,
      subjectType: 'user',
      subjectId: admin.id,
      scopeType: 'global',
      assignedBy: admin.id,
    },
  });
  adminUserId = admin.id;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await infra?.close();
});

describe('MFA policy matrix with a confirmed factor', () => {
  it.each([
    { clientId: 'app-optional', label: 'an optional client' },
    { clientId: 'app-required', label: 'a required_all client' },
    { clientId: 'app-admins', label: 'a required_admins client as a non-admin' },
  ])(
    'challenges an enrolled user on $label',
    async ({ clientId }) => {
      const user = await createUser('enrolled-matrix');
      const enrolled = await enrollTotp(user.id);

      const challenge = await login(user.username, clientId);
      expect(challenge.status).toBe(200);
      expect(challenge.headers['set-cookie']).toBeUndefined();
      expect(challenge.body).toMatchObject({ mfa: 'challenge', methods: ['totp', 'recovery'] });

      const verified = await verify(
        challenge.body.challengeToken,
        totpCode(enrolled.secret, Date.now()),
        'totp',
      );
      expect(verified.status).toBe(200);
      const session = await store.read(sessionCookieFrom(verified));
      expect(session?.userId).toBe(user.id);
      expect(session?.amr).toEqual(['pwd', 'totp']);
      expect(session?.acr).toBe(MFA_ACR);
    },
    60_000,
  );

  it('challenges an administrator under required_admins before issuing a session', async () => {
    const enrolled = await enrollTotp(adminUserId);
    const challenge = await login(
      (await infra.prisma.user.findUniqueOrThrow({ where: { id: adminUserId } })).username,
      'app-admins',
    );
    expect(challenge.status).toBe(200);
    expect(challenge.body.mfa).toBe('challenge');

    const verified = await verify(
      challenge.body.challengeToken,
      totpCode(enrolled.secret, Date.now()),
      'totp',
    );
    expect(verified.status).toBe(200);
  }, 60_000);
});

describe('login-context MFA override', () => {
  it('lets a relaxed context override a required_all client for a user without a factor', async () => {
    const user = await createUser('relaxed-context');

    const clientPolicy = await login(user.username, 'app-required');
    expect(clientPolicy.status).toBe(403);
    expect(clientPolicy.body.error).toBe('mfa_enrollment_required');
    expect(clientPolicy.headers['set-cookie']).toBeUndefined();

    const contextPolicy = await login(user.username, 'app-required', 'relaxed');
    expect(contextPolicy.status).toBe(200);
    expect(contextPolicy.body.ok).toBe(true);
    expect(contextPolicy.headers['set-cookie']).toBeDefined();
  }, 60_000);

  it('lets a strict context force enrollment on an optional client', async () => {
    const user = await createUser('strict-context');

    const relaxed = await login(user.username, 'app-optional');
    expect(relaxed.status).toBe(200);

    const strict = await login(user.username, 'app-optional', 'strict');
    expect(strict.status).toBe(403);
    expect(strict.body.error).toBe('mfa_enrollment_required');
    expect(strict.headers['set-cookie']).toBeUndefined();
  }, 60_000);
});

describe('MFA challenge binding and single use', () => {
  it('binds a challenge to its user and rejects another account TOTP code', async () => {
    const first = await createUser('bind-first');
    const second = await createUser('bind-second');
    const firstFactor = await enrollTotp(first.id);
    const secondFactor = await enrollTotp(second.id);

    const now = Date.now();
    const firstCode = totpCode(firstFactor.secret, now);
    let secondCode = totpCode(secondFactor.secret, now);
    if (secondCode === firstCode) {
      // Deterministic guard against the 1-in-a-million collision, still inside the ±1 window.
      secondCode = totpCode(secondFactor.secret, now + 30_000);
    }

    const challenge = await login(first.username, 'app-optional');
    const wrongUser = await verify(challenge.body.challengeToken, secondCode, 'totp');
    expect(wrongUser.status).toBe(401);
    expect(wrongUser.body.error).toBe('invalid_mfa_code');

    const accepted = await verify(challenge.body.challengeToken, firstCode, 'totp');
    expect(accepted.status).toBe(200);
    const session = await store.read(sessionCookieFrom(accepted));
    expect(session?.userId).toBe(first.id);
    expect(session?.userId).not.toBe(second.id);
  }, 60_000);

  it('consumes a TOTP step exactly once across two concurrent challenges', async () => {
    const user = await createUser('race-totp');
    const enrolled = await enrollTotp(user.id);
    const code = totpCode(enrolled.secret, Date.now());

    const first = await login(user.username, 'app-optional');
    const second = await login(user.username, 'app-optional');
    const [a, b] = await Promise.all([
      verify(first.body.challengeToken, code, 'totp'),
      verify(second.body.challengeToken, code, 'totp'),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 401]);
    const mfaSessions = await infra.prisma.session.count({
      where: { userId: user.id, amr: { has: 'totp' } },
    });
    expect(mfaSessions).toBe(1);
    const factor = await infra.prisma.mfaFactor.findUniqueOrThrow({
      where: { id: enrolled.factorId },
      select: { lastUsedStep: true },
    });
    expect(factor.lastUsedStep).not.toBeNull();
  }, 60_000);

  it('consumes a recovery code exactly once across two concurrent challenges', async () => {
    const user = await createUser('race-recovery');
    const enrolled = await enrollTotp(user.id);
    const code = enrolled.recoveryCodes[0] ?? '';

    const first = await login(user.username, 'app-optional');
    const second = await login(user.username, 'app-optional');
    const [a, b] = await Promise.all([
      verify(first.body.challengeToken, code, 'recovery'),
      verify(second.body.challengeToken, code, 'recovery'),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect(
      await infra.prisma.mfaRecoveryCode.count({
        where: { factorId: enrolled.factorId, usedAt: { not: null } },
      }),
    ).toBe(1);
    const winner = a.status === 200 ? a : b;
    const session = await store.read(sessionCookieFrom(winner));
    expect(session?.amr).toEqual(['pwd', 'recovery']);
  }, 60_000);

  it('ignores an unconfirmed factor until enrollment is confirmed', async () => {
    const user = await createUser('pending-factor');
    const session = await createSession(user.id);
    const start = await request(app.server)
      .post('/api/v1/account/mfa/totp/enroll')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ password: userPassword });
    expect(start.status).toBe(201);

    const optional = await login(user.username, 'app-optional');
    expect(optional.status).toBe(200);
    expect(optional.body.ok).toBe(true);
    expect(optional.body.mfa).toBeUndefined();
    expect(optional.headers['set-cookie']).toBeDefined();

    const required = await login(user.username, 'app-required');
    expect(required.status).toBe(403);
    expect(required.body.error).toBe('mfa_enrollment_required');
  }, 60_000);

  it('refuses a pending challenge after the factor was removed', async () => {
    const user = await createUser('removed-factor');
    const enrolled = await enrollTotp(user.id);
    const session = await createSession(user.id);

    const challenge = await login(user.username, 'app-optional');
    expect(challenge.body.mfa).toBe('challenge');

    const disabled = await request(app.server)
      .post('/api/v1/account/mfa/totp/disable')
      .set('Cookie', cookie(session))
      .set(sameOrigin)
      .send({ password: userPassword });
    expect(disabled.status).toBe(200);

    const response = await verify(
      challenge.body.challengeToken,
      totpCode(enrolled.secret, Date.now()),
      'totp',
    );
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('mfa_challenge_invalid');
    expect(response.headers['set-cookie']).toBeUndefined();
  }, 60_000);
});
