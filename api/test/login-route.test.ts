import Fastify from 'fastify';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { hashPassword, type Argon2Params } from '../src/auth/password.js';
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
  audits: Parameters<LoginUserRepository['registerFailedAttempt']>[0][];
  failures: { userId: string; attempts: number; lockedUntil: Date | null }[];
}

async function harness(
  currentUser: LoginUserRecord | null,
  now = new Date('2026-10-18T12:00:00Z'),
) {
  const app = Fastify({ logger: false });
  const sessions: IdpSession[] = [];
  const failures: { userId: string; attempts: number; lockedUntil: Date | null }[] = [];
  const audits: unknown[] = [];

  registerLoginRoute(app, {
    appUrl,
    users: {
      async findByIdentifier() {
        return currentUser;
      },
      async registerFailedAttempt(userId, attempts, lockedUntil) {
        failures.push({ userId, attempts, lockedUntil });
      },
      async registerSuccessfulLogin() {},
    },
    sessions: {
      async create(input) {
        const session: IdpSession = {
          sid: `sid-${sessions.length + 1}`,
          userId: input.userId,
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
    },
    audit: {
      async record(event) {
        audits.push(event);
      },
    },
    persistSession: async () => {},
    cookie: { secure: true, idleTtlSeconds: 1800, absoluteTtlSeconds: 28800 },
    now: () => now,
  });
  await app.ready();
  return { app, sessions, audits, failures } as unknown as Harness;
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
