import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAccountLifecycle } from '../src/account/lifecycle.js';
import { createPrismaLifecycleUserStore } from '../src/account/prisma-lifecycle-repository.js';
import { createPrismaAccountTokenStore } from '../src/account/prisma-token-repository.js';
import { issueAccountToken, type AccountTokenPurpose } from '../src/account/tokens.js';
import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaPasswordStore } from '../src/audit/prisma-audit.js';
import { hashPassword, verifyPassword, type Argon2Params } from '../src/auth/password.js';
import { createMemoryRateLimiter } from '../src/http/rate-limit.js';
import { RecordingMailer } from '../src/mail/recording-mailer.js';
import { buildServer } from '../src/server.js';
import { RedisSessionCache } from '../src/session/redis-cache.js';
import { RedisSessionStore } from '../src/session/store.js';
import type { IdpSession } from '../src/session/types.js';
import { startPhase4Infra, type Phase4Infra } from './phase4-harness.js';

/**
 * Phase-4 account lifecycle regression edges (docs/auth-flows.md 8, docs/testing.md 5).
 *
 * Complements `account-lifecycle.integration.test.ts` with TTL edges, policy/reuse failure
 * ordering, disabled/pending accounts and the failed-token audit redaction contract.
 */

const issuer = 'http://127.0.0.1:3420';
const existingPassword = 'existing-password-12';
const newPassword = 'a-brand-new-passphrase';
const FAST_ARGON2: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };

let infra: Phase4Infra;
let app: ReturnType<typeof buildServer>;
let mailer: RecordingMailer;
let sessions: RedisSessionStore;
let resetTokens: ReturnType<typeof createPrismaAccountTokenStore>;
let appAId: string;
let tenantId: string;
let sequence = 0;

const uniqueEmail = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@example.com`;

async function createUser(
  overrides: {
    status?: 'active' | 'pending' | 'locked' | 'disabled';
    passwordHash?: string | null;
    emailVerifiedAt?: Date | null;
    email?: string;
  } = {},
): Promise<{ id: string; email: string }> {
  sequence += 1;
  const email = overrides.email ?? uniqueEmail('lifecycle');
  const user = await infra.prisma.user.create({
    data: {
      tenantId,
      username: `lifecycle-${sequence}-${Date.now()}`,
      email,
      displayName: 'Lifecycle Regression',
      status: overrides.status ?? 'active',
      passwordHash:
        overrides.passwordHash === undefined
          ? await hashPassword(existingPassword, FAST_ARGON2)
          : overrides.passwordHash,
      emailVerifiedAt: overrides.emailVerifiedAt ?? null,
    },
  });
  return { id: user.id, email: user.email };
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
  await infra.prisma.session.create({
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

const tokenRow = (userId: string, purpose: AccountTokenPurpose) =>
  infra.prisma.accountToken.findFirst({
    where: { userId, purpose },
    orderBy: { createdAt: 'desc' },
    select: { consumedAt: true, expiresAt: true },
  });

beforeAll(async () => {
  infra = await startPhase4Infra('idpn_phase4_lifecycle');
  tenantId = infra.tenantId;
  sessions = new RedisSessionStore({
    cache: new RedisSessionCache(infra.redis),
    policy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600, maxConcurrentSessions: 0 },
  });

  const client = await infra.prisma.client.create({
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
  appAId = client.id;

  mailer = new RecordingMailer();
  resetTokens = createPrismaAccountTokenStore(infra.prisma);
  const audit = createPrismaAdminAudit(infra.prisma);
  const lifecycle = createAccountLifecycle({
    users: createPrismaLifecycleUserStore(infra.prisma),
    tokens: resetTokens,
    mailer,
    links: { uiBaseUrl: 'https://auth.example.com' },
  });

  app = buildServer({
    issuer,
    keys: infra.keys,
    accountLifecycle: {
      sessions,
      lifecycle,
      tokens: resetTokens,
      passwords: createPrismaPasswordStore(infra.prisma, { sessions }),
      rateLimit: createMemoryRateLimiter(),
      audit,
      hash: (password) => hashPassword(password, FAST_ARGON2),
    },
  });
  await app.ready();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await infra?.close();
});

describe('account token TTL', () => {
  it('rejects an expired invite link without activating the user or membership', async () => {
    const user = await createUser({ status: 'pending', passwordHash: null });
    const membership = await infra.prisma.clientMembership.create({
      data: { clientId: appAId, userId: user.id, status: 'invited' },
    });
    const issued = await issueAccountToken(
      resetTokens,
      { userId: user.id, purpose: 'invite' },
      () => new Date(Date.now() - 73 * 60 * 60 * 1000),
    );

    const response = await request(app.server)
      .post('/api/v1/account/invite/accept')
      .send({ token: issued.token, password: newPassword });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_token');

    const stored = await infra.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.status).toBe('pending');
    expect(stored.passwordHash).toBeNull();
    expect(stored.emailVerifiedAt).toBeNull();
    expect(
      (await infra.prisma.clientMembership.findUniqueOrThrow({ where: { id: membership.id } }))
        .status,
    ).toBe('invited');

    // Expiry is not a consumption: the row keeps its single-use state.
    expect((await tokenRow(user.id, 'invite'))?.consumedAt).toBeNull();

    const audit = await infra.prisma.auditEvent.findFirstOrThrow({
      where: { action: 'account.invite.token_failed', result: 'failure' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.metadata).toMatchObject({ reason: 'expired' });
    expect(JSON.stringify(audit.metadata)).not.toContain(issued.token);
  }, 60_000);

  it('rejects an expired reset link and keeps the password, sessions and refresh tokens', async () => {
    const user = await createUser({ emailVerifiedAt: new Date() });
    const session = await createSession(user.id);
    const refresh = await infra.prisma.refreshToken.create({
      data: {
        tokenHash: `expired-reset-${randomUUID()}`,
        familyId: randomUUID(),
        clientId: appAId,
        userId: user.id,
        sessionId: session.sid,
        scope: ['openid', 'offline_access'],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const issued = await issueAccountToken(
      resetTokens,
      { userId: user.id, purpose: 'password_reset' },
      () => new Date(Date.now() - 31 * 60 * 1000),
    );

    const response = await request(app.server)
      .post('/api/v1/account/password/reset')
      .send({ token: issued.token, password: newPassword });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_token');

    const stored = await infra.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(stored.passwordHash ?? '', existingPassword)).toBe(true);
    expect(await verifyPassword(stored.passwordHash ?? '', newPassword)).toBe(false);
    expect(
      (await infra.prisma.session.findUniqueOrThrow({ where: { id: session.sid } })).revokedAt,
    ).toBeNull();
    expect(
      (await infra.prisma.refreshToken.findUniqueOrThrow({ where: { id: refresh.id } })).revokedAt,
    ).toBeNull();
    expect((await tokenRow(user.id, 'password_reset'))?.consumedAt).toBeNull();
  }, 60_000);
});

describe('token consumption ordering', () => {
  it('keeps an invite link usable after a password policy violation', async () => {
    const user = await createUser({ status: 'pending', passwordHash: null });
    const membership = await infra.prisma.clientMembership.create({
      data: { clientId: appAId, userId: user.id, status: 'invited' },
    });
    const issued = await issueAccountToken(resetTokens, { userId: user.id, purpose: 'invite' });

    const weak = await request(app.server)
      .post('/api/v1/account/invite/accept')
      .send({ token: issued.token, password: 'short' });
    expect(weak.status).toBe(422);
    expect(weak.body.code).toBe('password_policy');
    expect((await tokenRow(user.id, 'invite'))?.consumedAt).toBeNull();

    const accepted = await request(app.server)
      .post('/api/v1/account/invite/accept')
      .send({ token: issued.token, password: newPassword });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ ok: true, emailVerified: true });
    expect((await tokenRow(user.id, 'invite'))?.consumedAt).not.toBeNull();
    expect(
      (await infra.prisma.clientMembership.findUniqueOrThrow({ where: { id: membership.id } }))
        .status,
    ).toBe('active');
  }, 60_000);

  it('keeps a reset link usable after the current password is rejected as reuse', async () => {
    const user = await createUser({ emailVerifiedAt: new Date() });
    const issued = await issueAccountToken(resetTokens, {
      userId: user.id,
      purpose: 'password_reset',
    });

    const reuse = await request(app.server)
      .post('/api/v1/account/password/reset')
      .send({ token: issued.token, password: existingPassword });
    expect(reuse.status).toBe(422);
    expect(reuse.body.code).toBe('password_reuse');

    // A rejected password must not burn the single-use link (same rule as policy failures).
    expect((await tokenRow(user.id, 'password_reset'))?.consumedAt).toBeNull();

    const reset = await request(app.server)
      .post('/api/v1/account/password/reset')
      .send({ token: issued.token, password: newPassword });
    expect(reset.status).toBe(200);
    const stored = await infra.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(stored.passwordHash ?? '', newPassword)).toBe(true);
  }, 60_000);
});

describe('disabled and pending accounts stay indistinguishable', () => {
  it.each([
    { label: 'disabled', status: 'disabled' as const, passwordHash: undefined },
    { label: 'pending without a password', status: 'pending' as const, passwordHash: null },
  ])(
    'answers like an unknown address for a $label account and sends no reset mail',
    async ({ status, passwordHash }) => {
      const user = await createUser({
        status,
        ...(passwordHash === undefined ? {} : { passwordHash }),
        emailVerifiedAt: new Date(),
      });
      const unknown = uniqueEmail('unknown-reset');
      const before = mailer.sent.length;

      const known = await request(app.server)
        .post('/api/v1/account/password/forgot')
        .send({ email: user.email });
      const missing = await request(app.server)
        .post('/api/v1/account/password/forgot')
        .send({ email: unknown });

      expect(known.status).toBe(202);
      expect(missing.status).toBe(202);
      expect(known.body).toEqual({ status: 'accepted' });
      expect(missing.body).toEqual(known.body);
      expect(mailer.sent.length).toBe(before);
      expect(mailer.lastTo(user.email)).toBeUndefined();
    },
    60_000,
  );

  it('rejects a reset link issued before the account was disabled', async () => {
    const user = await createUser({ emailVerifiedAt: new Date() });
    const issued = await issueAccountToken(resetTokens, {
      userId: user.id,
      purpose: 'password_reset',
    });
    await infra.prisma.user.update({ where: { id: user.id }, data: { status: 'disabled' } });

    const reset = await request(app.server)
      .post('/api/v1/account/password/reset')
      .send({ token: issued.token, password: newPassword });
    expect(reset.status).toBe(400);
    expect(reset.body.code).toBe('invalid_token');

    const stored = await infra.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(stored.passwordHash ?? '', existingPassword)).toBe(true);
    expect((await tokenRow(user.id, 'password_reset'))?.consumedAt).toBeNull();
  }, 60_000);
});

describe('failed-token audit redaction and rate limits', () => {
  it('records only a reason for unknown, wrong-purpose and expired token attempts', async () => {
    const user = await createUser({ emailVerifiedAt: new Date() });
    const since = new Date();
    const verification = await issueAccountToken(resetTokens, {
      userId: user.id,
      purpose: 'email_verification',
    });
    const reset = await issueAccountToken(resetTokens, {
      userId: user.id,
      purpose: 'password_reset',
    });
    const invalid = 'z'.repeat(43);

    const unknown = await request(app.server)
      .post('/api/v1/account/password/reset')
      .send({ token: invalid, password: newPassword });
    const wrongPurpose = await request(app.server)
      .post('/api/v1/account/password/reset')
      .send({ token: verification.token, password: newPassword });
    const wrongPurposeVerify = await request(app.server)
      .post('/api/v1/account/email/verify')
      .send({ token: reset.token });

    expect(unknown.status).toBe(400);
    expect(wrongPurpose.status).toBe(400);
    expect(wrongPurposeVerify.status).toBe(400);

    const failures = await infra.prisma.auditEvent.findMany({
      where: {
        occurredAt: { gte: since },
        action: { in: ['account.password_reset.token_failed', 'account.email.verify_failed'] },
        result: 'failure',
      },
      select: { metadata: true, targetId: true },
    });
    expect(failures.length).toBeGreaterThanOrEqual(2);
    for (const failure of failures) {
      expect(failure.metadata).toHaveProperty('reason');
      const serialized = JSON.stringify(failure.metadata);
      expect(serialized).not.toContain(invalid);
      expect(serialized).not.toContain(verification.token);
      expect(serialized).not.toContain(reset.token);
      expect(serialized).not.toContain(user.email);
      expect(failure.targetId).toBeNull();
    }
  }, 60_000);

  it('rate-limits verification requests for one address without revealing whether it exists', async () => {
    const unknown = uniqueEmail('verify-flood');
    const statuses: number[] = [];
    const bodies: unknown[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await request(app.server)
        .post('/api/v1/account/email/verification/request')
        .send({ email: unknown });
      statuses.push(response.status);
      bodies.push(response.body);
    }

    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses[5]).toBe(429);
    expect(bodies.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => ({ status: 'accepted' })));
    expect(mailer.lastTo(unknown)).toBeUndefined();
  }, 60_000);
});
