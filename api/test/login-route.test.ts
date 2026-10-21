import Fastify from 'fastify';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword, type Argon2Params } from '../src/auth/password.js';
import { createMemoryRateLimiter, type RateLimiter } from '../src/http/rate-limit.js';
import { registerLoginRoute } from '../src/login/routes.js';
import {
  normalizeIdentifier,
  sanitizeReturnTo,
  type LoginUserRecord,
  type LoginUserRepository,
} from '../src/login/login-types.js';
import type { IdpSession } from '../src/session/types.js';

const FAST: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const appUrl = 'https://auth.example.com';
const password = 'a-very-long-password';

const user = async (overrides: Partial<LoginUserRecord> = {}): Promise<LoginUserRecord> => ({
  id: 'user-1',
  tenantId: 'tenant-1',
  username: 'sara',
  email: 'sara@example.com',
  displayName: 'Sara',
  locale: 'fa-IR',
  status: 'active',
  passwordHash: await hashPassword(password, FAST),
  lockedUntil: null,
  failedLoginCount: 0,
  deletedAt: null,
  ...overrides,
});

interface Harness {
  app: ReturnType<typeof Fastify>;
  sessions: IdpSession[];
  persisted: { sid: string; clientId?: string; loginContext?: string }[];
  audits: Parameters<LoginUserRepository['registerFailedAttempt']>[0][];
  failures: { userId: string; attempts: number; lockedUntil: Date | null }[];
  revoked: { sid: string; reason: string }[];
  rehashed: { userId: string; hash: string }[];
}

interface HarnessOptions {
  rateLimiter?: RateLimiter;
  /** Makes the PostgreSQL mirror fail so the compensation path runs. */
  failPersist?: boolean;
  /** Hashing policy the route should apply; defaults to the library defaults. */
  passwordParams?: Argon2Params;
}

async function harness(
  currentUser: LoginUserRecord | null,
  now = new Date('2026-10-18T12:00:00Z'),
  options: HarnessOptions = {},
) {
  const app = Fastify({ logger: false });
  const sessions: IdpSession[] = [];
  const persisted: { sid: string; clientId?: string; loginContext?: string }[] = [];
  const failures: { userId: string; attempts: number; lockedUntil: Date | null }[] = [];
  const revoked: { sid: string; reason: string }[] = [];
  const rehashed: { userId: string; hash: string }[] = [];
  const audits: unknown[] = [];

  registerLoginRoute(app, {
    appUrl,
    ...(options.rateLimiter === undefined ? {} : { rateLimiter: options.rateLimiter }),
    ...(options.passwordParams === undefined ? {} : { passwordParams: options.passwordParams }),
    users: {
      async findByIdentifier() {
        return currentUser;
      },
      async registerFailedAttempt(userId, attempts, lockedUntil) {
        failures.push({ userId, attempts, lockedUntil });
      },
      async registerSuccessfulLogin() {},
      async rehashPassword(userId, hash) {
        rehashed.push({ userId, hash });
      },
    },
    sessions: {
      async create(input) {
        const session: IdpSession = {
          sid: `sid-${sessions.length + 1}`,
          userId: input.userId,
          ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
          ...(input.loginContext === undefined ? {} : { loginContext: input.loginContext }),
          createdAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          authTime: now.toISOString(),
          idleExpiresAt: now.toISOString(),
          absoluteExpiresAt: now.toISOString(),
          amr: input.amr,
          acr: input.acr,
        };
        sessions.push(session);
        return session;
      },
      async revoke(sid, reason) {
        revoked.push({ sid, reason });
        return true;
      },
    },
    audit: {
      async record(event) {
        audits.push(event);
      },
    },
    persistSession: async (input) => {
      if (options.failPersist === true) {
        throw new Error('mirror unavailable');
      }
      persisted.push(input);
    },
    cookie: { secure: true, idleTtlSeconds: 1800, absoluteTtlSeconds: 28800 },
    now: () => now,
  });
  await app.ready();
  return { app, sessions, persisted, audits, failures, revoked, rehashed } as unknown as Harness;
}

describe('POST /api/v1/login', () => {
  it('sets an HttpOnly session cookie and returns a safe redirect', async () => {
    const { app } = await harness(await user());

    const response = await request(app.server)
      .post('/api/v1/login')
      .send({
        identifier: 'sara@example.com',
        password,
        returnTo: '/oauth2/authorize?client_id=app-a',
      })
      .expect(200);

    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('idpn_session=sid-1');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      ok: true,
      redirectTo: '/oauth2/authorize?client_id=app-a',
    });

    await app.close();
  });

  it('upgrades the stored hash when the current policy is stronger', async () => {
    const current = await user();
    const stronger: Argon2Params = { memoryCost: 16_384, timeCost: 2, parallelism: 1 };
    const { app, rehashed } = await harness(current, undefined, { passwordParams: stronger });

    await request(app.server)
      .post('/api/v1/login')
      .send({ identifier: 'sara@example.com', password })
      .expect(200);

    expect(rehashed).toHaveLength(1);
    expect(rehashed[0]?.userId).toBe('user-1');
    expect(rehashed[0]?.hash).not.toBe(current.passwordHash);
    // The replacement is usable under the new policy, so the next login succeeds.
    expect(await verifyPassword(rehashed[0]?.hash ?? '', password, stronger)).toBe(true);
    await app.close();
  });

  it('leaves a hash that already matches the policy untouched', async () => {
    const current = await user();
    const { app, rehashed } = await harness(current, undefined, { passwordParams: FAST });

    await request(app.server)
      .post('/api/v1/login')
      .send({ identifier: 'sara@example.com', password })
      .expect(200);

    expect(rehashed).toEqual([]);
    await app.close();
  });

  it('returns the same generic error for unknown users and wrong passwords', async () => {
    const unknown = await harness(null);
    const wrong = await harness(await user());

    const unknownResponse = await request(unknown.app.server)
      .post('/api/v1/login')
      .send({ identifier: 'nobody@example.com', password })
      .expect(401);
    const wrongResponse = await request(wrong.app.server)
      .post('/api/v1/login')
      .send({ identifier: 'sara@example.com', password: 'wrong-password-1' })
      .expect(401);

    expect(unknownResponse.body).toEqual(wrongResponse.body);
    expect(unknownResponse.body.error).toBe('invalid_credentials');
    expect(unknownResponse.body.message).not.toContain('exist');
    await unknown.app.close();
    await wrong.app.close();
  });

  it('counts failed attempts and locks the account after five', async () => {
    const { app, failures } = await harness(await user({ failedLoginCount: 4 }));

    await request(app.server)
      .post('/api/v1/login')
      .send({ identifier: 'sara', password: 'wrong-password-1' })
      .expect(401);

    expect(failures[0]).toMatchObject({ userId: 'user-1', attempts: 5 });
    expect(failures[0]?.lockedUntil).toBeInstanceOf(Date);
    await app.close();
  });

  it('lets the lock expire and restarts the attempt counter', async () => {
    // The lock elapsed: the account is usable again even though the counter is still at 5.
    const { app, failures } = await harness(
      await user({
        status: 'active',
        failedLoginCount: 5,
        lockedUntil: new Date('2026-10-18T11:45:00Z'),
      }),
    );

    const response = await request(app.server)
      .post('/api/v1/login')
      .send({ identifier: 'sara@example.com', password })
      .expect(200);
    expect(response.body.ok).toBe(true);

    await request(app.server)
      .post('/api/v1/login')
      .send({ identifier: 'sara@example.com', password: 'wrong-password-1' })
      .expect(401);
    // One failure after the window closed: the counter restarted instead of re-locking.
    expect(failures[0]).toMatchObject({ userId: 'user-1', attempts: 1, lockedUntil: null });
    await app.close();
  });

  it('throttles credential attempts with a Redis-backed limiter', async () => {
    const { app } = await harness(await user(), undefined, {
      rateLimiter: createMemoryRateLimiter(),
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app.server)
        .post('/api/v1/login')
        .send({ identifier: 'sara@example.com', password: 'wrong-password-1' })
        .expect(401);
    }

    const throttled = await request(app.server)
      .post('/api/v1/login')
      .send({ identifier: 'sara@example.com', password })
      .expect(429);

    expect(throttled.body.error).toBe('too_many_requests');
    expect(throttled.headers['cache-control']).toBe('no-store');
    expect(throttled.headers['retry-after']).toBe('60');
    expect(String(throttled.headers['set-cookie'] ?? '')).not.toContain('idpn_session');
    await app.close();
  });

  it('records exactly one audit event per failed credential attempt', async () => {
    const { app, audits } = await harness(await user());

    await request(app.server)
      .post('/api/v1/login')
      .send({ identifier: 'sara@example.com', password: 'wrong-password-1' })
      .expect(401);

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'user.login.failed',
      result: 'failure',
      metadata: { reason: 'invalid_credentials', identifier: 's***@example.com' },
    });
    await app.close();
  });

  it('revokes the session when the PostgreSQL mirror fails', async () => {
    const { app, revoked } = await harness(await user(), undefined, { failPersist: true });

    await request(app.server)
      .post('/api/v1/login')
      .send({ identifier: 'sara@example.com', password })
      .expect(500);

    expect(revoked).toEqual([{ sid: 'sid-1', reason: 'persist_failed' }]);
    await app.close();
  });

  it('rejects disabled and locked users without revealing the reason', async () => {
    const disabled = await harness(await user({ status: 'disabled' }));
    const locked = await harness(
      await user({ status: 'locked', lockedUntil: new Date('2030-01-01T00:00:00Z') }),
    );

    for (const harnessed of [disabled, locked]) {
      const response = await request(harnessed.app.server)
        .post('/api/v1/login')
        .send({ identifier: 'sara@example.com', password })
        .expect(401);
      expect(response.body.error).toBe('invalid_credentials');
      await harnessed.app.close();
    }
  });

  it('rejects an unsafe returnTo and omits the redirect', async () => {
    const { app } = await harness(await user());

    for (const returnTo of [
      'https://evil.example/cb',
      '//evil.example/cb',
      'javascript:alert(1)',
    ]) {
      const response = await request(app.server)
        .post('/api/v1/login')
        .send({ identifier: 'sara@example.com', password, returnTo })
        .expect(200);
      expect(response.body.redirectTo).toBeUndefined();
    }

    const sameOrigin = await request(app.server)
      .post('/api/v1/login')
      .send({ identifier: 'sara@example.com', password, returnTo: `${appUrl}/oauth2/authorize` })
      .expect(200);
    expect(sameOrigin.body.redirectTo).toBe(`${appUrl}/oauth2/authorize`);

    await app.close();
  });

  it('never returns a token in the body', async () => {
    const { app } = await harness(await user());
    const response = await request(app.server)
      .post('/api/v1/login')
      .send({ identifier: 'sara@example.com', password })
      .expect(200);

    expect(Object.keys(response.body)).toEqual(['ok']);
    expect(JSON.stringify(response.body)).not.toContain('token');
    await app.close();
  });
});

describe('helpers', () => {
  it('normalizes email and username identifiers', () => {
    expect(normalizeIdentifier('  Sara@Example.COM ')).toBe('sara@example.com');
    expect(normalizeIdentifier('  SMohammadi ')).toBe('smohammadi');
  });

  it('keeps only relative or same-origin return targets', () => {
    expect(sanitizeReturnTo('/oauth2/authorize', appUrl)).toBe('/oauth2/authorize');
    expect(sanitizeReturnTo('//evil.example', appUrl)).toBeUndefined();
    expect(sanitizeReturnTo('/\\evil.example', appUrl)).toBeUndefined();
    expect(sanitizeReturnTo('https://evil.example/x', appUrl)).toBeUndefined();
    expect(sanitizeReturnTo('https://auth.example.com/x', appUrl)).toBe(`${appUrl}/x`);
    expect(sanitizeReturnTo(undefined, appUrl)).toBeUndefined();
  });
});

describe('POST /api/v1/login — session login context', () => {
  it('records the login context on the session and its PostgreSQL mirror', async () => {
    const { app, sessions, persisted } = await harness(await user());

    await request(app.server)
      .post('/api/v1/login')
      .send({
        identifier: 'sara@example.com',
        password,
        clientId: 'app-a',
        loginContext: 'customer-admin',
      })
      .expect(200);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      clientId: 'app-a',
      loginContext: 'customer-admin',
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      sid: sessions[0]?.sid,
      clientId: 'app-a',
      loginContext: 'customer-admin',
    });
    await app.close();
  });

  it('leaves a client-wide session unbound when no context is supplied', async () => {
    const { app, sessions, persisted } = await harness(await user());

    await request(app.server)
      .post('/api/v1/login')
      .send({ identifier: 'sara@example.com', password, clientId: 'app-a' })
      .expect(200);

    expect(sessions[0]?.loginContext).toBeUndefined();
    expect(persisted[0]?.loginContext).toBeUndefined();
    await app.close();
  });
});

describe('POST /api/v1/login — account status', () => {
  it('refuses to create a session for a pending account', async () => {
    const { app, sessions } = await harness(await user({ status: 'pending' }));

    const response = await request(app.server)
      .post('/api/v1/login')
      .send({ identifier: 'sara@example.com', password })
      .expect(401);

    expect(response.body).toEqual({
      error: 'invalid_credentials',
      message: expect.any(String),
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sessions).toHaveLength(0);
    await app.close();
  });
});
