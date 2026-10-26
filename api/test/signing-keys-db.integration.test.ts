import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createKeyringSecretBox } from '../src/crypto/secret-box.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { generateSigningKey, SigningKeyManager } from '../src/oidc/keys.js';
import { createPrismaSigningKeyRepository } from '../src/oidc/prisma-key-repository.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3100';
const wrapKey = { id: 1, key: Buffer.alloc(32, 11) };

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionString = '';
let prisma: PrismaClient;

const box = createKeyringSecretBox({ current: wrapKey, previous: [] });

const replica = (options: { cooldown?: number } = {}) =>
  new SigningKeyManager(createPrismaSigningKeyRepository(prisma, box), () => new Date(), {
    retiredRetentionSeconds: 3600,
    keyCacheTtlSeconds: 0,
    ...(options.cooldown === undefined ? {} : { rotationCooldownSeconds: options.cooldown }),
  });

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_signing_keys_${Date.now()}`;
    serverClient = new Client({ connectionString: external });
    await serverClient.connect();
    await serverClient.query(`CREATE DATABASE "${scratchDatabase}"`);
    const url = new URL(external);
    url.pathname = `/${scratchDatabase}`;
    connectionString = url.toString();
  } else {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(180_000)
      .start();
    connectionString = container.getConnectionUri();
  }
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString },
  });
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

describe('db:// signing key store', () => {
  it('lets two replicas sign and verify with the same key', async () => {
    const first = replica();
    const second = replica();
    const created = await first.ensureKey();

    // The second replica finds the key the first one created instead of minting its own.
    const adopted = await second.ensureKey();
    expect(adopted.kid).toBe(created.kid);

    const token = await first.signAccessToken(
      { scope: 'openid' },
      { issuer, audience: 'app-a', subject: 'user-1', expiresInSeconds: 300 },
    );
    await expect(second.verify(token, { issuer, audience: 'app-a' })).resolves.toMatchObject({
      sub: 'user-1',
    });
  });

  it('never stores the private key unencrypted', async () => {
    const rows = await prisma.signingKey.findMany();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.privateKeyRef.startsWith('enc:')).toBe(true);
      expect(row.privateKeyRef).not.toContain('"d"');
      expect(row.publicKey).not.toContain('"d"');
      const decoded = Buffer.from(row.privateKeyRef.slice(4), 'base64');
      expect(decoded[0]).toBe(2);
      expect(decoded[1]).toBe(wrapKey.id);
    }
  });

  it('refuses a substituted public key or a kid that is not the key thumbprint', async () => {
    await replica().ensureKey();
    const repository = createPrismaSigningKeyRepository(prisma, box);
    const target = (await prisma.signingKey.findFirstOrThrow({ where: { status: 'active' } })).kid;
    const original = await prisma.signingKey.findUniqueOrThrow({ where: { kid: target } });
    const attacker = await generateSigningKey('active');

    try {
      // Swap in the attacker's public key: the IdP would publish it and RPs would trust it.
      await prisma.signingKey.update({
        where: { kid: target },
        data: { publicKey: JSON.stringify(attacker.publicJwk) },
      });
      await expect(repository.list()).rejects.toThrow(/does not match the private key/);
    } finally {
      await prisma.signingKey.update({
        where: { kid: target },
        data: { publicKey: original.publicKey },
      });
    }
    expect((await repository.list()).length).toBeGreaterThan(0);

    // Re-labelling the row under another kid is rejected too (kid must be the thumbprint).
    await prisma.signingKey.update({ where: { kid: target }, data: { kid: 'a'.repeat(43) } });
    try {
      await expect(repository.list()).rejects.toThrow(/not the thumbprint/);
    } finally {
      await prisma.signingKey.update({ where: { kid: 'a'.repeat(43) }, data: { kid: target } });
    }
  });

  it('refuses to read the keys without the wrap key', async () => {
    const wrong = createKeyringSecretBox({
      current: { id: 1, key: Buffer.alloc(32, 99) },
      previous: [],
    });
    const repository = createPrismaSigningKeyRepository(prisma, wrong);
    await expect(repository.list()).rejects.toThrow(/could not be decrypted/);
  });

  it('rotates across replicas, keeps one active key and publishes the overlap', async () => {
    const first = replica();
    const second = replica();
    const before = await first.ensureKey();

    const rotated = await second.rotate();
    expect(rotated.previousKid).toBe(before.kid);

    const jwks = await first.jwks();
    expect(jwks.keys.map((key) => key.kid)).toEqual(
      expect.arrayContaining([before.kid, rotated.active.kid]),
    );
    const active = await prisma.signingKey.count({ where: { status: 'active' } });
    expect(active).toBe(1);
    expect((await first.ensureKey()).kid).toBe(rotated.active.kid);
  });

  it('lets only one of two concurrent rotations leave an active key', async () => {
    const a = replica();
    const b = replica();
    await a.ensureKey();

    const results = await Promise.allSettled([a.rotate(), b.rotate()]);

    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    // Whatever happened, the database holds exactly one active key.
    expect(await prisma.signingKey.count({ where: { status: 'active' } })).toBe(1);
  });

  it('honours the rotation cool-down shared through the database', async () => {
    const manager = replica({ cooldown: 600 });
    await manager.ensureKey();
    await manager.rotate({ revokePrevious: true });
    await expect(manager.rotate()).rejects.toMatchObject({ name: 'KeyRotationCooldownError' });
  });

  it('re-wraps envelopes under a new wrap key without changing the signing key', async () => {
    const oldBox = box;
    const nextBox = createKeyringSecretBox({
      current: { id: 2, key: Buffer.alloc(32, 12) },
      previous: [wrapKey],
    });
    const rows = await prisma.signingKey.findMany();
    for (const row of rows) {
      const plaintext = nextBox.decrypt(Buffer.from(row.privateKeyRef.slice(4), 'base64'));
      expect(oldBox.decrypt(Buffer.from(row.privateKeyRef.slice(4), 'base64'))).toBe(plaintext);
      expect(nextBox.needsRewrap(Buffer.from(row.privateKeyRef.slice(4), 'base64'))).toBe(true);
    }
    const reader = createPrismaSigningKeyRepository(prisma, nextBox);
    expect((await reader.list()).length).toBe(rows.length);
  });
});
