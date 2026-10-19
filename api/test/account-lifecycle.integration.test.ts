import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAccountLifecycle } from '../src/account/lifecycle.js';
import { createPrismaLifecycleUserStore } from '../src/account/prisma-lifecycle-repository.js';
import { createPrismaAccountTokenStore } from '../src/account/prisma-token-repository.js';
import { issueAccountToken } from '../src/account/tokens.js';
import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaMemberRepository } from '../src/admin/members/prisma-member-repository.js';
import { createPrismaRbacRepository } from '../src/admin/rbac/prisma-rbac-repository.js';
import { createPrismaPasswordStore } from '../src/audit/prisma-audit.js';
import { hashPassword, verifyPassword, type Argon2Params } from '../src/auth/password.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createMemoryRateLimiter } from '../src/http/rate-limit.js';
import { RecordingMailer } from '../src/mail/recording-mailer.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { buildServer } from '../src/server.js';
import { RedisSessionCache } from '../src/session/redis-cache.js';
import { RedisSessionStore } from '../src/session/store.js';
import type { IdpSession } from '../src/session/types.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3100';
const uiBaseUrl = 'https://auth.example.com';
const existingPassword = 'existing-password-12';
const newPassword = 'a-brand-new-passphrase';
const FAST_ARGON2: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

let container: StartedPostgreSqlContainer | undefined;
let redisContainer: StartedRedisContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let redis: Redis;
let prisma: PrismaClient;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let tenantId: string;
let appAId: string;
let adminUserId: string;
let mailer: RecordingMailer;
let sessions: RedisSessionStore;
let resetTokens: ReturnType<typeof createPrismaAccountTokenStore>;

const connectionString = (): string => connectionStringValue;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

async function sign(userId: string, scope: string): Promise<string> {
  const token = await keys.signAccessToken(
    { scope, client_id: 'admin-panel', auth_time: nowSeconds() },
    { issuer, audience: 'admin-panel', subject: userId, expiresInSeconds: 300 },
  );
  return `Bearer ${token}`;
}

const adminAuth = (): Promise<string> => sign(adminUserId, 'openid idp.admin');

const uniqueEmail = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@example.com`;

async function createUser(
  email: string,
  overrides: {
    status?: 'active' | 'pending' | 'locked' | 'disabled';
    passwordHash?: string | null;
    emailVerifiedAt?: Date | null;
    username?: string;
  } = {},
): Promise<string> {
  const username = overrides.username ?? `u${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  const user = await prisma.user.create({
    data: {
      tenantId,
      username,
      email,
      displayName: 'Test User',
      status: overrides.status ?? 'active',
      passwordHash:
        overrides.passwordHash === undefined
          ? await hashPassword(existingPassword, FAST_ARGON2)
          : overrides.passwordHash,
      emailVerifiedAt: overrides.emailVerifiedAt ?? null,
    },
  });
  return user.id;
}

async function createSession(userId: string): Promise<IdpSession> {
  const session = await sessions.create({
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
      clientId: appAId,
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

async function createRefreshToken(userId: string, sessionId: string): Promise<void> {
  await prisma.refreshToken.create({
    data: {
      tokenHash: randomUUID(),
      familyId: randomUUID(),
      clientId: appAId,
      userId,
      sessionId,
      scope: ['openid', 'offline_access'],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
}

function tokenFromMail(text: string): string {
  const match = text.match(/[?&]token=([A-Za-z0-9_-]+)/);
  if (match?.[1] === undefined) {
    throw new Error('mail did not contain a token');
  }
  return match[1];
}

const cookie = (session: IdpSession): string => `idpn_session=${session.sid}`;
const sameOrigin = { Origin: issuer };

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_lifecycle_${Date.now()}`;
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
  sessions = new RedisSessionStore({
    cache: new RedisSessionCache(redis),
    policy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600, maxConcurrentSessions: 0 },
  });

  keys = new SigningKeyManager(new MemorySigningKeyRepository());
  await keys.ensureKey();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  tenantId = tenant.id;
  const appA = await prisma.client.create({
    data: {
      clientId: 'app-a',
      name: 'App A',
      type: 'web',
      redirectUris: [],
      postLogoutRedirectUris: [],
      allowedOrigins: [],
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      tenantId,
    },
  });
  appAId = appA.id;
  await prisma.client.create({
    data: {
      clientId: 'admin-panel',
      name: 'Admin',
      type: 'web',
      redirectUris: [],
      postLogoutRedirectUris: [],
      allowedOrigins: [],
      scopes: ['openid', 'idp.admin'],
      tenantId,
    },
  });

  const permission = await prisma.permission.create({
    data: { key: 'idp:client-member:invite', description: 'invite' },
  });
  const adminRole = await prisma.role.create({
    data: {
      key: 'lifecycle-admin',
      name: 'Lifecycle admin',
      description: 'testing',
      rolePermissions: { create: [{ permissionId: permission.id }] },
    },
  });
  await prisma.role.create({
    data: {
      key: 'app-a:member',
      name: 'Member',
      description: 'default member',
      clientId: appAId,
      isDefault: true,
    },
  });
  adminUserId = await createUser('admin@example.com', { username: 'admin' });
  await prisma.assignment.create({
    data: {
      subjectType: 'user',
      subjectId: adminUserId,
      roleId: adminRole.id,
      scopeType: 'global',
      assignedBy: adminUserId,
    },
  });

  mailer = new RecordingMailer();
  const audit = createPrismaAdminAudit(prisma);
  const lifecycleUsers = createPrismaLifecycleUserStore(prisma);
  resetTokens = createPrismaAccountTokenStore(prisma);
  const lifecycle = createAccountLifecycle({
    users: lifecycleUsers,
    tokens: resetTokens,
    mailer,
    links: { uiBaseUrl },
  });
  const rateLimit = createMemoryRateLimiter();
  const passwords = createPrismaPasswordStore(prisma, { sessions });
  const rbac = createPrismaRbacRepository(prisma);

  app = buildServer({
    issuer,
    keys,
    adminMembers: {
      adminClientId: 'admin-panel',
      permissions: createPrismaPermissionReader(prisma),
      members: createPrismaMemberRepository(prisma, { rbac }),
      audit,
      notifications: { sendInvite: (userId) => lifecycle.sendInvite(userId) },
      rateLimit,
    },
    accountLifecycle: {
      sessions,
      lifecycle,
      tokens: resetTokens,
      passwords,
      rateLimit,
      audit,
      hash: (password) => hashPassword(password, FAST_ARGON2),
    },
  });
  await app.ready();
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

describe('invitation flow', () => {
  it('emails a single-use link, sets the password, verifies the email and activates membership', async () => {
    const email = uniqueEmail('invite');
    const response = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', await adminAuth())
      .send({ email });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ createdUser: true, invited: true });
    const userId = response.body.member.userId as string;

    const message = mailer.lastTo(email);
    expect(message?.subject).toBe('دعوت‌نامه');
    expect(message?.text).toContain('action=set-password');
    const token = tokenFromMail(message?.text ?? '');

    const accepted = await request(app.server)
      .post('/api/v1/account/invite/accept')
      .send({ token, password: newPassword });

    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ ok: true, emailVerified: true });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.status).toBe('active');
    expect(stored.emailVerifiedAt).not.toBeNull();
    expect(stored.mustChangePassword).toBe(false);
    expect(await verifyPassword(stored.passwordHash ?? '', newPassword)).toBe(true);

    const membership = await prisma.clientMembership.findFirstOrThrow({ where: { userId } });
    expect(membership.status).toBe('active');
    expect(membership.joinedAt).not.toBeNull();

    const tokenRow = await prisma.accountToken.findFirstOrThrow({ where: { userId } });
    expect(tokenRow.consumedAt).not.toBeNull();
    expect(tokenRow.tokenHash).not.toBe(token);

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'account.invite.accepted', targetId: userId },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain(token);

    const replay = await request(app.server)
      .post('/api/v1/account/invite/accept')
      .send({ token, password: 'another-long-password' });
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ code: 'invalid_token' });
  }, 60_000);

  it('notifies an existing user without a token', async () => {
    const email = uniqueEmail('existing');
    const userId = await createUser(email);

    const response = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', await adminAuth())
      .send({ email });

    expect(response.status).toBe(201);
    expect(response.body.createdUser).toBe(false);

    const message = mailer.lastTo(email);
    expect(message?.subject).toBe('افزودن به یک اپلیکیشن');
    expect(JSON.stringify(message)).not.toMatch(/token=|https?:/);
    expect(await prisma.accountToken.count({ where: { userId } })).toBe(0);
  }, 60_000);

  it('resends only while the invitation is pending and rate-limits after five attempts', async () => {
    const email = uniqueEmail('resend');
    const invited = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', await adminAuth())
      .send({ email });
    const userId = invited.body.member.userId as string;
    const firstToken = tokenFromMail(mailer.lastTo(email)?.text ?? '');

    const first = await request(app.server)
      .post(`/api/v1/clients/app-a/members/${userId}/invite/resend`)
      .set('Authorization', await adminAuth());
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ status: 'accepted', delivery: 'invitation' });

    const secondToken = tokenFromMail(mailer.lastTo(email)?.text ?? '');
    expect(secondToken).not.toBe(firstToken);

    // The older link was invalidated by the resend.
    const stale = await request(app.server)
      .post('/api/v1/account/invite/accept')
      .send({ token: firstToken, password: newPassword });
    expect(stale.status).toBe(400);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const allowed = await request(app.server)
        .post(`/api/v1/clients/app-a/members/${userId}/invite/resend`)
        .set('Authorization', await adminAuth());
      expect(allowed.status).toBe(202);
    }
    const limited = await request(app.server)
      .post(`/api/v1/clients/app-a/members/${userId}/invite/resend`)
      .set('Authorization', await adminAuth());
    expect(limited.status).toBe(429);

    const accepted = await request(app.server)
      .post('/api/v1/account/invite/accept')
      .send({ token: secondToken, password: newPassword });
    expect(accepted.status).toBe(400); // the latest resend replaced it long before acceptance
  }, 60_000);
});

describe('email verification', () => {
  it('answers identically for known and unknown addresses and verifies only with a valid token', async () => {
    const email = uniqueEmail('verify');
    const userId = await createUser(email);
    const unknown = uniqueEmail('nobody');
    const before = mailer.sent.length;

    const known = await request(app.server)
      .post('/api/v1/account/email/verification/request')
      .send({ email });
    const missing = await request(app.server)
      .post('/api/v1/account/email/verification/request')
      .send({ email: unknown });

    expect(known.status).toBe(202);
    expect(missing.status).toBe(202);
    expect(known.body).toEqual(missing.body);
    expect(mailer.sent.length).toBe(before + 1);
    expect(mailer.lastTo(unknown)).toBeUndefined();

    const token = tokenFromMail(mailer.lastTo(email)?.text ?? '');
    const confirmed = await request(app.server)
      .post('/api/v1/account/email/verify')
      .send({ token });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual({ ok: true, emailVerified: true });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.emailVerifiedAt).not.toBeNull();

    const replay = await request(app.server).post('/api/v1/account/email/verify').send({ token });
    expect(replay.status).toBe(400);

    const audits = await prisma.auditEvent.findMany({
      where: { action: 'account.email.verification_requested' },
      orderBy: { occurredAt: 'desc' },
      take: 2,
    });
    expect(audits).toHaveLength(2);
    expect(audits.some((entry) => entry.targetId === null)).toBe(true);
    expect(JSON.stringify(audits.map((entry) => entry.metadata))).not.toContain(token);
    expect(JSON.stringify(audits.map((entry) => entry.metadata))).not.toContain(email);
  }, 60_000);

  it('rejects an expired verification token', async () => {
    const email = uniqueEmail('expired');
    const userId = await createUser(email);
    const issued = await issueAccountToken(
      resetTokens,
      { userId, purpose: 'email_verification' },
      () => new Date(Date.now() - 25 * 60 * 60 * 1000),
    );

    const response = await request(app.server)
      .post('/api/v1/account/email/verify')
      .send({ token: issued.token });
    expect(response.status).toBe(400);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.emailVerifiedAt).toBeNull();
  }, 60_000);

  it('resends from the account session and reports already-verified accounts', async () => {
    const email = uniqueEmail('resend-verify');
    const userId = await createUser(email);
    const session = await createSession(userId);

    const crossOrigin = await request(app.server)
      .post('/api/v1/account/email/verification')
      .set('Cookie', cookie(session))
      .set('Content-Type', 'application/json')
      .send({});
    expect(crossOrigin.status).toBe(403);

    const sent = await request(app.server)
      .post('/api/v1/account/email/verification')
      .set(sameOrigin)
      .set('Cookie', cookie(session))
      .set('Content-Type', 'application/json')
      .send({});
    expect(sent.status).toBe(202);
    const token = tokenFromMail(mailer.lastTo(email)?.text ?? '');
    await request(app.server).post('/api/v1/account/email/verify').send({ token });

    const again = await request(app.server)
      .post('/api/v1/account/email/verification')
      .set(sameOrigin)
      .set('Cookie', cookie(session))
      .set('Content-Type', 'application/json')
      .send({});
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ status: 'already_verified' });
  }, 60_000);
});

describe('password reset', () => {
  it('keeps one active token, enforces policy before consuming, revokes sessions and audits', async () => {
    const email = uniqueEmail('reset');
    const userId = await createUser(email, { emailVerifiedAt: new Date() });
    const session = await createSession(userId);
    await createRefreshToken(userId, session.sid);
    const unknown = uniqueEmail('missing');

    const known = await request(app.server).post('/api/v1/account/password/forgot').send({ email });
    const missing = await request(app.server)
      .post('/api/v1/account/password/forgot')
      .send({ email: unknown });
    expect(known.status).toBe(202);
    expect(missing.status).toBe(202);
    expect(known.body).toEqual(missing.body);
    expect(mailer.lastTo(unknown)).toBeUndefined();

    const firstToken = tokenFromMail(mailer.lastTo(email)?.text ?? '');
    // A second request invalidates the first link (one active token per user).
    const second = await request(app.server)
      .post('/api/v1/account/password/forgot')
      .send({ email });
    expect(second.status).toBe(202);
    const secondToken = tokenFromMail(mailer.lastTo(email)?.text ?? '');
    expect(secondToken).not.toBe(firstToken);

    const stale = await request(app.server)
      .post('/api/v1/account/password/reset')
      .send({ token: firstToken, password: newPassword });
    expect(stale.status).toBe(400);

    const weak = await request(app.server)
      .post('/api/v1/account/password/reset')
      .send({ token: secondToken, password: 'short' });
    expect(weak.status).toBe(422);
    expect(weak.body).toMatchObject({ code: 'password_policy' });

    // The policy failure did not spend the link.
    const reset = await request(app.server)
      .post('/api/v1/account/password/reset')
      .send({ token: secondToken, password: newPassword });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ ok: true });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.mustChangePassword).toBe(false);
    expect(await verifyPassword(stored.passwordHash ?? '', newPassword)).toBe(true);
    expect(await verifyPassword(stored.passwordHash ?? '', existingPassword)).toBe(false);

    const revokedSession = await prisma.session.findUniqueOrThrow({ where: { id: session.sid } });
    expect(revokedSession.revokedAt).not.toBeNull();
    expect(revokedSession.revokeReason).toBe('password_change');
    const refresh = await prisma.refreshToken.findFirstOrThrow({ where: { userId } });
    expect(refresh.revokedAt).not.toBeNull();
    // Redis is the source of truth for the next `/authorize`; it must be gone too.
    expect(await sessions.read(session.sid)).toBeNull();

    expect(mailer.lastTo(email)?.subject).toBe('رمز عبور شما تغییر کرد');

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'account.password.reset', targetId: userId },
    });
    expect(audit.result).toBe('success');
    const allAudit = await prisma.auditEvent.findMany({ where: { targetId: userId } });
    expect(JSON.stringify(allAudit.map((entry) => entry.metadata))).not.toContain(secondToken);

    const replay = await request(app.server)
      .post('/api/v1/account/password/reset')
      .send({ token: secondToken, password: 'another-long-password' });
    expect(replay.status).toBe(400);
  }, 60_000);

  it('rate-limits reset requests for one address', async () => {
    const email = uniqueEmail('flood');
    await createUser(email);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await request(app.server)
        .post('/api/v1/account/password/forgot')
        .send({ email });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses[5]).toBe(429);

    const limited = await request(app.server)
      .post('/api/v1/account/password/forgot')
      .send({ email });
    expect(limited.headers['retry-after']).toBe('3600');
  }, 60_000);

  it('rejects unknown, replayed and wrong-purpose tokens uniformly', async () => {
    const email = uniqueEmail('uniform');
    const userId = await createUser(email);
    const verification = await issueAccountToken(resetTokens, {
      userId,
      purpose: 'email_verification',
    });

    const unknown = await request(app.server)
      .post('/api/v1/account/password/reset')
      .send({ token: 'a'.repeat(43), password: newPassword });
    const wrongPurpose = await request(app.server)
      .post('/api/v1/account/password/reset')
      .send({ token: verification.token, password: newPassword });

    expect(unknown.status).toBe(400);
    expect(wrongPurpose.status).toBe(400);
    expect(unknown.body).toEqual(wrongPurpose.body);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await verifyPassword(stored.passwordHash ?? '', existingPassword)).toBe(true);
  }, 60_000);
});
