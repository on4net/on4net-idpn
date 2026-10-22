import Fastify from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createClientSecretService,
  hashClientSecret,
  loadClientSecretPeppers,
  type ClientSecretPeppers,
  type ClientSecretService,
} from '../src/auth/client-secret.js';
import { hashPassword, type Argon2Params } from '../src/auth/password.js';
import { createPrismaClientRepository } from '../src/oidc/prisma-client-repository.js';
import { registerTokenRoute, type TokenRouteOptions } from '../src/oidc/token-route.js';
import { startPhase4Infra, type Phase4Infra } from './phase4-harness.js';

/**
 * Client-secret storage and the `/oauth2/token` exchange (issue #68).
 *
 * Runs against a real PostgreSQL instance so the opportunistic upgrade of a legacy Argon2id
 * row is proven at the storage layer, not only in memory.
 */

const FAST: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const CLIENT_SECRET = 'Q7fK2mZ9pR4sT6vW8xY1aB3cD5eG0hJ2';
const OTHER_SECRET = 'M1nB4vC7xZ0lK3jH6gF9dS2aQ5wE8rT1';
const SCOPE = 'reports:read';
const issuer = 'http://127.0.0.1:3100';

const peppers: ClientSecretPeppers = {
  current: { id: 'k1', value: Buffer.from('integration-client-secret-pepper-1', 'utf8') },
  previous: [],
};

let infra: Phase4Infra;
let clientSecrets: ClientSecretService;
let app: ReturnType<typeof Fastify>;

const exchange = (clientId: string, secret: string, method: 'basic' | 'post' = 'basic') => {
  const body: Record<string, string> = {
    grant_type: 'client_credentials',
    scope: SCOPE,
    ...(method === 'post' ? { client_id: clientId, client_secret: secret } : {}),
  };
  const pending = request(app.server).post('/oauth2/token');
  if (method === 'basic') {
    pending.set(
      'Authorization',
      `Basic ${Buffer.from(`${clientId}:${secret}`, 'utf8').toString('base64')}`,
    );
  }
  return pending.send(body);
};

interface SeedClientInput {
  clientId: string;
  secretHashes: string[];
  status?: 'active' | 'disabled';
  secret?: {
    revokedAt?: Date;
    expiresAt?: Date | null;
  };
}

async function seedClient(input: SeedClientInput): Promise<void> {
  const client = await infra.prisma.client.create({
    data: {
      clientId: input.clientId,
      name: input.clientId,
      type: 'm2m',
      redirectUris: [],
      postLogoutRedirectUris: [],
      allowedOrigins: [],
      scopes: [SCOPE, 'openid'],
      status: input.status ?? 'active',
      tenantId: infra.tenantId,
    },
  });
  let index = 0;
  for (const secretHash of input.secretHashes) {
    await infra.prisma.clientSecret.create({
      data: {
        clientId: client.id,
        secretHash,
        prefix: `prefix-${index}`,
        ...(input.secret?.revokedAt === undefined ? {} : { revokedAt: input.secret.revokedAt }),
        ...(input.secret?.expiresAt === undefined ? {} : { expiresAt: input.secret.expiresAt }),
      },
    });
    index += 1;
  }
}

async function storedHashes(clientId: string): Promise<string[]> {
  const rows = await infra.prisma.clientSecret.findMany({
    where: { client: { clientId }, revokedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { secretHash: true },
  });
  return rows.map((row) => row.secretHash);
}

beforeAll(async () => {
  infra = await startPhase4Infra('client_secret');
  clientSecrets = createClientSecretService(peppers);

  app = Fastify({ logger: false });
  registerTokenRoute(app, {
    issuer,
    keys: infra.keys,
    clients: createPrismaClientRepository(infra.prisma),
    clientSecrets,
    codes: {
      async create() {},
      async findByHash() {
        return null;
      },
      async markConsumed() {
        return false;
      },
    },
    refreshTokens: {
      async create() {},
      async findByHash() {
        return null;
      },
      async markRotated() {
        return false;
      },
      async revokeFamily() {
        return 0;
      },
      async revokeByHash() {
        return false;
      },
    },
    users: {
      async findProfile() {
        return null;
      },
    },
    now: () => new Date('2026-10-20T08:00:00Z'),
  } satisfies TokenRouteOptions);
  await app.ready();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await infra?.close();
});

describe('POST /oauth2/token with the keyed-HMAC client secret', () => {
  it('issues a token for a v2 secret without rewriting the stored hash', async () => {
    await seedClient({
      clientId: 'new-client',
      secretHashes: [hashClientSecret(CLIENT_SECRET, peppers)],
    });

    const response = await exchange('new-client', CLIENT_SECRET).expect(200);
    expect(response.body.token_type).toBe('Bearer');
    expect(typeof response.body.access_token).toBe('string');
    expect(JSON.stringify(response.body)).not.toContain(CLIENT_SECRET);
    await expect(storedHashes('new-client')).resolves.toEqual([
      hashClientSecret(CLIENT_SECRET, peppers),
    ]);
  });

  it('accepts client_secret_post with the same scheme', async () => {
    await seedClient({
      clientId: 'post-client',
      secretHashes: [hashClientSecret(CLIENT_SECRET, peppers)],
    });

    await exchange('post-client', CLIENT_SECRET, 'post').expect(200);
  });

  it('rejects a wrong secret without touching the stored hash', async () => {
    const hash = hashClientSecret(CLIENT_SECRET, peppers);
    await seedClient({ clientId: 'wrong-secret-client', secretHashes: [hash] });

    const response = await exchange('wrong-secret-client', OTHER_SECRET).expect(401);
    expect(response.body.error).toBe('invalid_client');
    await expect(storedHashes('wrong-secret-client')).resolves.toEqual([hash]);
  });

  it('rejects the secret of another client', async () => {
    await seedClient({
      clientId: 'cross-a',
      secretHashes: [hashClientSecret(CLIENT_SECRET, peppers)],
    });
    await seedClient({
      clientId: 'cross-b',
      secretHashes: [hashClientSecret(OTHER_SECRET, peppers)],
    });

    await exchange('cross-a', OTHER_SECRET).expect(401);
    await exchange('cross-b', CLIENT_SECRET).expect(401);
    await exchange('cross-a', CLIENT_SECRET).expect(200);
  });

  it('rejects a revoked, an expired and a disabled credential', async () => {
    const hash = hashClientSecret(CLIENT_SECRET, peppers);
    await seedClient({
      clientId: 'revoked-client',
      secretHashes: [hash],
      secret: { revokedAt: new Date('2026-10-19T00:00:00Z') },
    });
    await seedClient({
      clientId: 'expired-client',
      secretHashes: [hash],
      secret: { expiresAt: new Date('2026-10-19T00:00:00Z') },
    });
    await seedClient({
      clientId: 'disabled-client',
      secretHashes: [hash],
      status: 'disabled',
    });

    await exchange('revoked-client', CLIENT_SECRET).expect(401);
    await exchange('expired-client', CLIENT_SECRET).expect(401);
    await exchange('disabled-client', CLIENT_SECRET).expect(401);
  });
});

describe('legacy Argon2id client secrets', () => {
  it('authenticates once and upgrades the row to v2 without locking the client out', async () => {
    const legacy = await hashPassword(CLIENT_SECRET, FAST);
    await seedClient({ clientId: 'legacy-client', secretHashes: [legacy] });

    await exchange('legacy-client', CLIENT_SECRET).expect(200);

    const upgraded = await storedHashes('legacy-client');
    expect(upgraded).toEqual([hashClientSecret(CLIENT_SECRET, peppers)]);

    // Idempotent: the same secret keeps working and the row is stable.
    await exchange('legacy-client', CLIENT_SECRET).expect(200);
    await expect(storedHashes('legacy-client')).resolves.toEqual(upgraded);
    // The old slow hash is gone, so a wrong secret cannot re-trigger Argon2id.
    await exchange('legacy-client', OTHER_SECRET).expect(401);
  });

  it('does not upgrade the row when the legacy verification fails', async () => {
    const legacy = await hashPassword(CLIENT_SECRET, FAST);
    await seedClient({ clientId: 'legacy-wrong-client', secretHashes: [legacy] });

    await exchange('legacy-wrong-client', OTHER_SECRET).expect(401);
    await expect(storedHashes('legacy-wrong-client')).resolves.toEqual([legacy]);
  });
});

describe('pepper rotation', () => {
  it('accepts a previous pepper and rehashes with the current one', async () => {
    const rotated: ClientSecretPeppers = {
      current: { id: 'k2', value: Buffer.from('integration-client-secret-pepper-2', 'utf8') },
      previous: [peppers.current],
    };
    const rotatedApp = Fastify({ logger: false });
    registerTokenRoute(rotatedApp, {
      issuer,
      keys: infra.keys,
      clients: createPrismaClientRepository(infra.prisma),
      clientSecrets: createClientSecretService(rotated),
      codes: {
        async create() {},
        async findByHash() {
          return null;
        },
        async markConsumed() {
          return false;
        },
      },
      refreshTokens: {
        async create() {},
        async findByHash() {
          return null;
        },
        async markRotated() {
          return false;
        },
        async revokeFamily() {
          return 0;
        },
        async revokeByHash() {
          return false;
        },
      },
      users: {
        async findProfile() {
          return null;
        },
      },
    });
    await rotatedApp.ready();

    const previousHash = hashClientSecret(CLIENT_SECRET, peppers);
    await seedClient({ clientId: 'rotating-client', secretHashes: [previousHash] });

    await request(rotatedApp.server)
      .post('/oauth2/token')
      .set(
        'Authorization',
        `Basic ${Buffer.from(`rotating-client:${CLIENT_SECRET}`).toString('base64')}`,
      )
      .send({ grant_type: 'client_credentials', scope: SCOPE })
      .expect(200);

    await expect(storedHashes('rotating-client')).resolves.toEqual([
      hashClientSecret(CLIENT_SECRET, rotated),
    ]);
    await rotatedApp.close();
  });

  it('keeps the configured pepper registry usable from the environment', () => {
    const loaded = loadClientSecretPeppers({
      NODE_ENV: 'production',
      CLIENT_SECRET_PEPPER: 'production-client-secret-pepper-value-32',
      CLIENT_SECRET_PEPPER_ID: 'k2',
      CLIENT_SECRET_PREVIOUS_PEPPERS: 'k1:previous-client-secret-pepper-value-32',
    });

    expect(loaded.current.id).toBe('k2');
    expect(loaded.previous.map((pepper) => pepper.id)).toEqual(['k1']);
  });
});
