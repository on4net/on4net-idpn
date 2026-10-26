import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { registerFormBodyParser } from '../src/http/form-body.js';
import {
  s256Challenge,
  type AuthorizationCodeRecord,
  type AuthorizationCodeRepository,
} from '../src/oidc/authorization-code.js';
import { registerAuthorizeRoute } from '../src/oidc/authorize-route.js';
import { createPrismaConsentRepository, MemoryConsentRequestStore } from '../src/oidc/consent.js';
import { registerConsentRoutes } from '../src/oidc/consent-routes.js';
import { createPrismaClientRepository } from '../src/oidc/prisma-client-repository.js';
import type { IdpSession } from '../src/session/types.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'https://auth.example.com';
const redirectUri = 'https://partner.example.com/callback';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let prisma: PrismaClient;
let app: FastifyInstance;
let userId: string;
let otherUserId: string;

const sessions = new Map<string, IdpSession>();
const codes = new Map<string, AuthorizationCodeRecord>();
const requests = new MemoryConsentRequestStore();

const codeRepository: AuthorizationCodeRepository = {
  async create(record) {
    codes.set(record.codeHash, record);
  },
  async findByHash(hash) {
    return codes.get(hash) ?? null;
  },
  async markConsumed() {
    return true;
  },
};

const makeSession = (sid: string, user: string): IdpSession => {
  const session: IdpSession = {
    sid,
    userId: user,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    authTime: new Date().toISOString(),
    idleExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 28_800_000).toISOString(),
    amr: ['pwd'],
    acr: 'urn:on4net:acr:pwd',
  };
  sessions.set(sid, session);
  return session;
};

const query = {
  response_type: 'code',
  client_id: 'partner-app',
  redirect_uri: redirectUri,
  scope: 'openid profile',
  state: 'state-xyz',
  nonce: 'nonce-1',
  code_challenge: s256Challenge(verifier),
  code_challenge_method: 'S256',
};

const sameOrigin = { Origin: issuer, 'Content-Type': 'application/json' };

/** Starts an authorization and returns the consent handle from the redirect. */
async function startAuthorization(cookie = 'idpn_session=sid-user'): Promise<string> {
  const response = await request(app.server)
    .get('/oauth2/authorize')
    .query(query)
    .set('Cookie', cookie)
    .expect(302);
  const location = new URL(String(response.headers.location));
  expect(location.searchParams.get('action')).toBe('consent');
  return String(location.searchParams.get('consent_request'));
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  let connectionString: string;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_consent_${Date.now()}`;
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

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  const user = (name: string) =>
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        username: name,
        email: `${name}@example.com`,
        displayName: name,
        status: 'active',
      },
    });
  userId = (await user('consenting')).id;
  otherUserId = (await user('someone-else')).id;

  const client = (clientId: string, name: string, firstParty: boolean) =>
    prisma.client.create({
      data: {
        clientId,
        name,
        type: 'web',
        redirectUris: [redirectUri],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes: ['openid', 'profile', 'email'],
        firstParty,
        tenantId: tenant.id,
      },
    });
  await client('partner-app', 'Partner Portal', false);
  await client('house-app', 'House App', true);

  makeSession('sid-user', userId);
  makeSession('sid-other', otherUserId);

  const clients = createPrismaClientRepository(prisma);
  const consents = createPrismaConsentRepository(prisma);

  app = Fastify({ logger: false });
  registerFormBodyParser(app);
  registerAuthorizeRoute(app, {
    issuer,
    clients,
    codes: codeRepository,
    sessions: { read: async (sid) => sessions.get(sid) ?? null },
    isConsentGranted: (user, clientId, scopes) => consents.isGranted(user, clientId, scopes),
    consentRequests: requests,
    membershipStatus: async () => 'active',
    authenticationRequirement: async () => ({
      mfaRequired: false,
      freshAuthenticationRequired: false,
    }),
  });
  registerConsentRoutes(app, {
    appUrl: issuer,
    sessions: { read: async (sid) => sessions.get(sid) ?? null },
    requests,
    consents,
    clients,
    audit: createPrismaAdminAudit(prisma),
  });
  await app.ready();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

describe('consent repository', () => {
  it('covers requested scopes by subset, widens on a new approval and re-prompts after revoke', async () => {
    const consents = createPrismaConsentRepository(prisma);
    const at = new Date('2026-10-26T10:00:00Z');

    expect(await consents.isGranted(otherUserId, 'partner-app', ['openid'])).toBe(false);

    await consents.grant(otherUserId, 'partner-app', ['openid', 'profile'], at);
    expect(await consents.isGranted(otherUserId, 'partner-app', ['openid', 'profile'])).toBe(true);
    expect(await consents.isGranted(otherUserId, 'partner-app', ['openid'])).toBe(true);
    expect(await consents.isGranted(otherUserId, 'partner-app', ['openid', 'email'])).toBe(false);

    await consents.grant(otherUserId, 'partner-app', ['email'], at);
    expect(
      await consents.isGranted(otherUserId, 'partner-app', ['openid', 'profile', 'email']),
    ).toBe(true);

    expect(await consents.revoke(otherUserId, 'partner-app', at)).toBe(true);
    expect(await consents.isGranted(otherUserId, 'partner-app', ['openid'])).toBe(false);
    expect(await consents.revoke(otherUserId, 'partner-app', at)).toBe(false);

    // A fresh approval after a revocation starts from the new scopes only.
    await consents.grant(otherUserId, 'partner-app', ['openid'], at);
    expect(await consents.isGranted(otherUserId, 'partner-app', ['openid', 'profile'])).toBe(false);
    await consents.revoke(otherUserId, 'partner-app', at);
  });

  it('keeps approvals per user and per client', async () => {
    const consents = createPrismaConsentRepository(prisma);
    await consents.grant(otherUserId, 'house-app', ['openid'], new Date());
    expect(await consents.isGranted(otherUserId, 'partner-app', ['openid'])).toBe(false);
    expect(await consents.isGranted(userId, 'house-app', ['openid'])).toBe(false);
    expect((await consents.listForUser(otherUserId)).map((entry) => entry.clientId)).toEqual([
      'house-app',
    ]);
    await consents.revoke(otherUserId, 'house-app', new Date());
  });
});

describe('authorize → consent → code', () => {
  it('never auto-approves a third-party client, and a first-party client is not prompted', async () => {
    const before = codes.size;
    await startAuthorization();
    expect(codes.size).toBe(before);

    const house = await request(app.server)
      .get('/oauth2/authorize')
      .query({ ...query, client_id: 'house-app' })
      .set('Cookie', 'idpn_session=sid-user');
    // The house client has no redirect URI registered for this callback, so it is rejected by
    // validation rather than by consent; what matters is that it is not sent to the screen.
    expect(String(house.headers.location ?? '')).not.toContain('action=consent');
  });

  it('shows the user what is being asked and only to the user it belongs to', async () => {
    const handle = await startAuthorization();

    await request(app.server).get(`/api/v1/consent/requests/${handle}`).expect(401);
    await request(app.server)
      .get(`/api/v1/consent/requests/${handle}`)
      .set('Cookie', 'idpn_session=sid-other')
      .expect(404);

    const shown = await request(app.server)
      .get(`/api/v1/consent/requests/${handle}`)
      .set('Cookie', 'idpn_session=sid-user')
      .expect(200);
    expect(shown.body).toEqual({
      client: { clientId: 'partner-app', name: 'Partner Portal' },
      scopes: ['openid', 'profile'],
    });
  });

  it('refuses a decision that is cross-site or not JSON, and keeps the request alive', async () => {
    const handle = await startAuthorization();
    await request(app.server)
      .post(`/api/v1/consent/requests/${handle}/decision`)
      .set('Cookie', 'idpn_session=sid-user')
      .set({ Origin: 'https://evil.example', 'Content-Type': 'application/json' })
      .send({ decision: 'allow' })
      .expect(403);
    await request(app.server)
      .post(`/api/v1/consent/requests/${handle}/decision`)
      .set('Cookie', 'idpn_session=sid-user')
      .set({ Origin: issuer })
      .type('form')
      .send('decision=allow')
      .expect(403);
    await request(app.server)
      .get(`/api/v1/consent/requests/${handle}`)
      .set('Cookie', 'idpn_session=sid-user')
      .expect(200);
    await request(app.server)
      .post(`/api/v1/consent/requests/${handle}/decision`)
      .set('Cookie', 'idpn_session=sid-user')
      .set(sameOrigin)
      .send({ decision: 'deny' })
      .expect(200);
  });

  it('deny sends access_denied to the client and records nothing as granted', async () => {
    const handle = await startAuthorization();

    const denied = await request(app.server)
      .post(`/api/v1/consent/requests/${handle}/decision`)
      .set('Cookie', 'idpn_session=sid-user')
      .set(sameOrigin)
      .send({ decision: 'deny' })
      .expect(200);

    const target = new URL(denied.body.redirectTo as string);
    expect(target.origin + target.pathname).toBe(redirectUri);
    expect(target.searchParams.get('error')).toBe('access_denied');
    expect(target.searchParams.get('state')).toBe('state-xyz');
    expect(
      await createPrismaConsentRepository(prisma).isGranted(userId, 'partner-app', ['openid']),
    ).toBe(false);
    const audit = await prisma.auditEvent.findFirst({ where: { action: 'consent.denied' } });
    expect(audit).toMatchObject({ result: 'failure', actorId: userId });

    // The request is spent.
    await request(app.server)
      .post(`/api/v1/consent/requests/${handle}/decision`)
      .set('Cookie', 'idpn_session=sid-user')
      .set(sameOrigin)
      .send({ decision: 'allow' })
      .expect(404);
  });

  it('allow records the grant, resumes /authorize, and the next authorization is not prompted', async () => {
    const handle = await startAuthorization();

    // Someone else cannot decide for this user.
    await request(app.server)
      .post(`/api/v1/consent/requests/${handle}/decision`)
      .set('Cookie', 'idpn_session=sid-other')
      .set(sameOrigin)
      .send({ decision: 'allow' })
      .expect(404);

    const allowed = await request(app.server)
      .post(`/api/v1/consent/requests/${handle}/decision`)
      .set('Cookie', 'idpn_session=sid-user')
      .set(sameOrigin)
      .send({ decision: 'allow' })
      .expect(200);
    const resume = new URL(allowed.body.redirectTo as string);
    expect(resume.pathname).toBe('/oauth2/authorize');

    const before = codes.size;
    const issued = await request(app.server)
      .get(`${resume.pathname}${resume.search}`)
      .set('Cookie', 'idpn_session=sid-user')
      .expect(302);
    const callback = new URL(String(issued.headers.location));
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get('code')).toBeTruthy();
    expect(codes.size).toBe(before + 1);

    const audit = await prisma.auditEvent.findFirst({ where: { action: 'consent.granted' } });
    expect(audit).toMatchObject({ result: 'success', actorId: userId });
  });

  it('revocation makes the next authorization prompt again, and prompt=none answers consent_required', async () => {
    const list = await request(app.server)
      .get('/api/v1/consent/grants')
      .set('Cookie', 'idpn_session=sid-user')
      .expect(200);
    expect(list.body.items).toMatchObject([
      { clientId: 'partner-app', clientName: 'Partner Portal', scopes: ['openid', 'profile'] },
    ]);

    await request(app.server)
      .delete('/api/v1/consent/grants/partner-app')
      .set('Cookie', 'idpn_session=sid-user')
      .set({ Origin: 'https://evil.example' })
      .expect(403);
    await request(app.server)
      .delete('/api/v1/consent/grants/partner-app')
      .set('Cookie', 'idpn_session=sid-user')
      .set({ Origin: issuer })
      .expect(204);
    await request(app.server)
      .delete('/api/v1/consent/grants/partner-app')
      .set('Cookie', 'idpn_session=sid-user')
      .set({ Origin: issuer })
      .expect(404);

    await startAuthorization();

    const silent = await request(app.server)
      .get('/oauth2/authorize')
      .query({ ...query, prompt: 'none' })
      .set('Cookie', 'idpn_session=sid-user')
      .expect(302);
    const location = new URL(String(silent.headers.location));
    expect(location.searchParams.get('error')).toBe('consent_required');
    expect(location.searchParams.get('state')).toBe('state-xyz');
  });

  it('asks again when a later request needs a scope that was never approved', async () => {
    const consents = createPrismaConsentRepository(prisma);
    await consents.grant(userId, 'partner-app', ['openid', 'profile'], new Date());

    const response = await request(app.server)
      .get('/oauth2/authorize')
      .query({ ...query, scope: 'openid profile email' })
      .set('Cookie', 'idpn_session=sid-user')
      .expect(302);
    expect(new URL(String(response.headers.location)).searchParams.get('action')).toBe('consent');
    await consents.revoke(userId, 'partner-app', new Date());
  });
});
