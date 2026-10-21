import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { s256Challenge } from '../src/oidc/authorization-code.js';
import { createAuthorizeMembershipStatus } from '../src/oidc/authorize-enforcement.js';
import { createPrismaEffectiveAccessSource } from '../src/oidc/effective-access.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { createPrismaLoginContextAccessSource } from '../src/oidc/login-context-access.js';
import { createPrismaClientRepository } from '../src/oidc/prisma-client-repository.js';
import { createPrismaCodeRepository } from '../src/oidc/prisma-code-repository.js';
import { createPrismaRefreshTokenRepository } from '../src/oidc/prisma-refresh-repository.js';
import { createPrismaUserRepository } from '../src/oidc/prisma-user-repository.js';
import { hashRefreshToken } from '../src/oidc/refresh-token.js';
import { buildServer } from '../src/server.js';
import type { IdpSession } from '../src/session/types.js';

/**
 * Login Context enforcement across `/authorize`, `/token` and `/userinfo`
 * (docs/login-contexts.md 4, 5, 6, 9; docs/testing.md INT-CTX-001..004).
 *
 * The suite is deliberately negative-heavy: every positive context flow has a matching
 * unknown/disabled/cross-client/missing-membership/suspended attempt that must be rejected
 * and must not leave a usable token behind.
 */

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3200';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';

type AppClientId = 'app-a' | 'app-b';

const REDIRECT_URI: Record<AppClientId, string> = {
  'app-a': 'https://app-a.example.com/callback',
  'app-b': 'https://app-b.example.com/callback',
};

interface Fixtures {
  users: { member: string; suspended: string; revocable: string };
  sessions: { member: string; suspended: string; revocable: string };
}

interface IssuedTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  scope: string;
}

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let prisma: PrismaClient;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let state: Fixtures;

const sessionMap = new Map<string, IdpSession>();

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionStringValue },
  });
}

async function verifyAccess(
  token: string,
  audience: AppClientId,
): Promise<Record<string, unknown>> {
  return keys.verify(token, { issuer, audience });
}

async function authorize(params: {
  clientId: AppClientId;
  sessionId?: string;
  loginContext?: string;
  prompt?: string;
  scope?: string;
}): Promise<URL> {
  const query: Record<string, string> = {
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: REDIRECT_URI[params.clientId],
    scope: params.scope ?? 'openid',
    state: 'state-1',
    nonce: 'nonce-1',
    code_challenge: s256Challenge(verifier),
    code_challenge_method: 'S256',
    ...(params.loginContext === undefined ? {} : { login_context: params.loginContext }),
    ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
  };
  const pending = request(app.server).get('/oauth2/authorize').query(query);
  if (params.sessionId !== undefined) {
    pending.set('Cookie', `idpn_session=${params.sessionId}`);
  }
  const response = await pending.expect(302);
  const location = response.headers.location;
  expect(location).toEqual(expect.any(String));
  return new URL(location as string);
}

async function issueTokens(params: {
  clientId: AppClientId;
  sessionId: string;
  loginContext?: string;
  scope?: string;
}): Promise<IssuedTokens> {
  const location = await authorize({
    clientId: params.clientId,
    sessionId: params.sessionId,
    ...(params.loginContext === undefined ? {} : { loginContext: params.loginContext }),
    ...(params.scope === undefined ? {} : { scope: params.scope }),
  });
  expect(location.searchParams.get('error')).toBeNull();
  const code = location.searchParams.get('code');
  expect(code).toEqual(expect.any(String));

  const response = await request(app.server)
    .post('/oauth2/token')
    .send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI[params.clientId],
      client_id: params.clientId,
      code_verifier: verifier,
      ...(params.loginContext === undefined ? {} : { login_context: params.loginContext }),
    });
  expect(response.status).toBe(200);
  return response.body as IssuedTokens;
}

async function exchangeCode(params: {
  clientId: AppClientId;
  code: string;
  loginContext?: string;
  redirectUri?: string;
}): Promise<request.Response> {
  return request(app.server)
    .post('/oauth2/token')
    .send({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri ?? REDIRECT_URI[params.clientId],
      client_id: params.clientId,
      code_verifier: verifier,
      ...(params.loginContext === undefined ? {} : { login_context: params.loginContext }),
    });
}

async function refreshToken(params: {
  clientId: AppClientId;
  token: string;
  loginContext?: string;
}): Promise<request.Response> {
  return request(app.server)
    .post('/oauth2/token')
    .send({
      grant_type: 'refresh_token',
      refresh_token: params.token,
      client_id: params.clientId,
      ...(params.loginContext === undefined ? {} : { login_context: params.loginContext }),
    });
}

async function addMembership(input: {
  clientId: AppClientId;
  userId: string;
  loginContextId: string | null;
  status?: 'active' | 'invited' | 'suspended';
  attributes?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const client = await prisma.client.findUniqueOrThrow({ where: { clientId: input.clientId } });
  return prisma.clientMembership.create({
    data: {
      clientId: client.id,
      userId: input.userId,
      loginContextId: input.loginContextId,
      status: input.status ?? 'active',
      attributes: (input.attributes ?? {}) as never,
      joinedAt: new Date(),
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_context_${Date.now()}`;
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

  keys = new SigningKeyManager(new MemorySigningKeyRepository());
  await keys.ensureKey();

  const clients = createPrismaClientRepository(prisma);
  const users = createPrismaUserRepository(prisma);
  const effectiveAccess = createPrismaEffectiveAccessSource(prisma);

  app = buildServer({
    issuer,
    keys,
    token: {
      clients,
      codes: createPrismaCodeRepository(prisma),
      refreshTokens: createPrismaRefreshTokenRepository(prisma),
      users,
      sessions: {
        async read(sid) {
          return sessionMap.get(sid) ?? null;
        },
      },
      access: effectiveAccess,
      contextAccess: createPrismaLoginContextAccessSource(prisma),
    },
    authorize: {
      clients,
      membershipStatus: createAuthorizeMembershipStatus(prisma),
    },
    userInfo: { users, access: effectiveAccess },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  const createClient = (clientId: AppClientId) =>
    prisma.client.create({
      data: {
        clientId,
        name: clientId,
        type: 'spa',
        redirectUris: [REDIRECT_URI[clientId]],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes: ['openid', 'offline_access'],
        tenantId: tenant.id,
      },
    });
  const appA = await createClient('app-a');
  const appB = await createClient('app-b');

  const permission = (key: string, clientId: string | null) =>
    prisma.permission.create({ data: { key, description: key, clientId } });
  const contactRead = await permission('app-a:contact:read', appA.id);
  const contactWrite = await permission('app-a:contact:write', appA.id);
  const reportExport = await permission('app-a:report:export', appA.id);
  const secretRead = await permission('app-b:secret:read', appB.id);
  const userRead = await permission('idp:user:read', null);

  const role = (key: string, clientId: string | null, permissions: { id: string }[]) =>
    prisma.role.create({
      data: {
        key,
        name: key,
        description: key,
        clientId,
        rolePermissions: { create: permissions.map((entry) => ({ permissionId: entry.id })) },
      },
    });
  const memberRole = await role('app-a:member', appA.id, [contactRead]);
  const editorRole = await role('app-a:editor', appA.id, [contactWrite]);
  const managerRole = await role('app-a:manager', appA.id, [reportExport]);
  const appBMember = await role('app-b:member', appB.id, [secretRead]);
  const superadmin = await role('idp:superadmin', null, [userRead]);

  const context = (
    clientId: string,
    key: string,
    allowedRoles: string[],
    options: { isDefault?: boolean; status?: 'active' | 'disabled' } = {},
  ) =>
    prisma.clientLoginContext.create({
      data: {
        clientId,
        key,
        name: key,
        allowedRoles,
        defaultRoles: [],
        loginMethods: ['password'],
        status: options.status ?? 'active',
        isDefault: options.isDefault ?? false,
        sessionIdleTtl: 1800,
        sessionAbsoluteTtl: 28_800,
      },
      select: { id: true },
    });
  const customerAdmin = await context(appA.id, 'customer-admin', ['app-a:editor'], {
    isDefault: true,
  });
  const customerTeam = await context(appA.id, 'customer-team', ['app-a:member']);
  await context(appA.id, 'no-members', ['app-a:editor']);
  await context(appA.id, 'disabled-context', ['app-a:manager'], { status: 'disabled' });
  const partnerPortal = await context(appB.id, 'partner-portal', ['app-b:member']);

  const createUser = (username: string) =>
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        username,
        email: `${username}@example.com`,
        displayName: username,
        status: 'active',
      },
      select: { id: true },
    });
  const member = await createUser('ali');
  const suspended = await createUser('suspended');
  const revocable = await createUser('revocable');

  await addMembership({
    clientId: 'app-a',
    userId: member.id,
    loginContextId: customerAdmin.id,
    attributes: { companyId: 'c-42' },
  });
  await addMembership({
    clientId: 'app-a',
    userId: member.id,
    loginContextId: customerTeam.id,
    attributes: { teamId: 't-7' },
  });
  await addMembership({
    clientId: 'app-a',
    userId: member.id,
    loginContextId: null,
    attributes: { legacy: true },
  });
  await addMembership({
    clientId: 'app-b',
    userId: member.id,
    loginContextId: partnerPortal.id,
    attributes: { partner: true },
  });
  await addMembership({
    clientId: 'app-a',
    userId: suspended.id,
    loginContextId: customerAdmin.id,
    status: 'suspended',
  });
  await addMembership({
    clientId: 'app-a',
    userId: revocable.id,
    loginContextId: customerTeam.id,
  });

  const assign = (userId: string, roleId: string) =>
    prisma.assignment.create({
      data: {
        subjectType: 'user',
        subjectId: userId,
        roleId,
        scopeType: 'global',
        assignedBy: member.id,
      },
    });
  for (const roleId of [memberRole.id, editorRole.id, managerRole.id, superadmin.id]) {
    await assign(member.id, roleId);
  }
  await assign(suspended.id, editorRole.id);
  await assign(revocable.id, memberRole.id);
  await assign(member.id, appBMember.id);

  const createSession = async (userId: string): Promise<string> => {
    const row = await prisma.session.create({
      data: {
        userId,
        idleExpiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 7_200_000),
        amr: ['pwd'],
        acr: 'urn:on4net:acr:pwd',
      },
    });
    sessionMap.set(row.id, {
      sid: row.id,
      userId,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      authTime: row.createdAt.toISOString(),
      idleExpiresAt: row.idleExpiresAt.toISOString(),
      absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
      amr: [...row.amr],
      acr: row.acr,
    });
    return row.id;
  };

  state = {
    users: { member: member.id, suspended: suspended.id, revocable: revocable.id },
    sessions: {
      member: await createSession(member.id),
      suspended: await createSession(suspended.id),
      revocable: await createSession(revocable.id),
    },
  };
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

describe('authorize login_context resolution', () => {
  it('issues a context-bound code for an active context of the client', async () => {
    const tokens = await issueTokens({
      clientId: 'app-a',
      sessionId: state.sessions.member,
      loginContext: 'customer-team',
    });
    const claims = await verifyAccess(tokens.access_token, 'app-a');
    expect(claims.login_context).toBe('customer-team');
    expect(claims.roles).toEqual(['app-a:member']);
  });

  it('rejects an unknown context with invalid_request', async () => {
    const location = await authorize({
      clientId: 'app-a',
      sessionId: state.sessions.member,
      loginContext: 'ghost-context',
    });
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('rejects a disabled context with invalid_request', async () => {
    const location = await authorize({
      clientId: 'app-a',
      sessionId: state.sessions.member,
      loginContext: 'disabled-context',
    });
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('rejects a context owned by another client with invalid_request', async () => {
    const location = await authorize({
      clientId: 'app-a',
      sessionId: state.sessions.member,
      loginContext: 'partner-portal',
    });
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('rejects a context without an active membership with access_denied', async () => {
    const location = await authorize({
      clientId: 'app-a',
      sessionId: state.sessions.member,
      loginContext: 'no-members',
    });
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('rejects a suspended context membership with access_denied', async () => {
    const location = await authorize({
      clientId: 'app-a',
      sessionId: state.sessions.suspended,
      loginContext: 'customer-admin',
    });
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('returns the selected context to the Hosted UI', async () => {
    const location = await authorize({
      clientId: 'app-a',
      loginContext: 'customer-admin',
    });
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('login_context')).toBe('customer-admin');
    expect(location.searchParams.get('return_to')).toContain('login_context=customer-admin');
  });

  it('honours login_context for silent SSO (prompt=none)', async () => {
    const location = await authorize({
      clientId: 'app-a',
      sessionId: state.sessions.member,
      loginContext: 'customer-admin',
      prompt: 'none',
    });
    expect(location.searchParams.get('error')).toBeNull();
    const code = location.searchParams.get('code');
    expect(code).toEqual(expect.any(String));

    const response = await exchangeCode({ clientId: 'app-a', code: code as string });
    expect(response.status).toBe(200);
    const claims = await verifyAccess(response.body.access_token, 'app-a');
    expect(claims.login_context).toBe('customer-admin');
    expect(claims.roles).toEqual(['app-a:editor']);
  });

  it('returns login_required for prompt=none without a session and never issues a code', async () => {
    const location = await authorize({
      clientId: 'app-a',
      loginContext: 'customer-admin',
      prompt: 'none',
    });
    expect(location.searchParams.get('error')).toBe('login_required');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('returns access_denied for prompt=none when the context membership is suspended', async () => {
    const location = await authorize({
      clientId: 'app-a',
      sessionId: state.sessions.suspended,
      loginContext: 'customer-admin',
      prompt: 'none',
    });
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('leaves a request without login_context context-free (deterministic legacy path)', async () => {
    const tokens = await issueTokens({ clientId: 'app-a', sessionId: state.sessions.member });
    const claims = await verifyAccess(tokens.access_token, 'app-a');
    expect(claims.login_context).toBeUndefined();
    expect(claims.roles).toEqual(['app-a:editor', 'app-a:manager', 'app-a:member']);
    expect(claims.membership).toEqual({
      context: null,
      status: 'active',
      attributes: { legacy: true },
    });
  });
});

describe('token role resolution per context', () => {
  it('issues different roles, permissions and membership for two contexts of one client', async () => {
    const adminTokens = await issueTokens({
      clientId: 'app-a',
      sessionId: state.sessions.member,
      loginContext: 'customer-admin',
    });
    const teamTokens = await issueTokens({
      clientId: 'app-a',
      sessionId: state.sessions.member,
      loginContext: 'customer-team',
    });

    const adminClaims = await verifyAccess(adminTokens.access_token, 'app-a');
    expect(adminClaims.login_context).toBe('customer-admin');
    expect(adminClaims.roles).toEqual(['app-a:editor']);
    expect(adminClaims.permissions).toEqual(['app-a:contact:write']);
    expect(adminClaims.membership).toEqual({
      context: 'customer-admin',
      status: 'active',
      attributes: { companyId: 'c-42' },
    });

    const teamClaims = await verifyAccess(teamTokens.access_token, 'app-a');
    expect(teamClaims.login_context).toBe('customer-team');
    expect(teamClaims.roles).toEqual(['app-a:member']);
    expect(teamClaims.permissions).toEqual(['app-a:contact:read']);
    expect(teamClaims.membership).toEqual({
      context: 'customer-team',
      status: 'active',
      attributes: { teamId: 't-7' },
    });

    // Roles outside `allowed_roles` (manager) and global idp:* roles never leak.
    for (const claims of [adminClaims, teamClaims]) {
      expect(claims.roles).not.toContain('app-a:manager');
      expect(claims.permissions).not.toContain('app-a:report:export');
      expect((claims.roles as string[]).some((key) => key.startsWith('idp:'))).toBe(false);
      expect(claims.client_id).toBe('app-a');
      expect(claims.aud).toBe('app-a');
    }
    expect(adminClaims.roles).not.toContain('app-a:member');
    expect(teamClaims.roles).not.toContain('app-a:editor');
  });

  it('carries the context in the ID token', async () => {
    const tokens = await issueTokens({
      clientId: 'app-a',
      sessionId: state.sessions.member,
      loginContext: 'customer-team',
    });
    const idClaims = await keys.verify(tokens.id_token as string, { issuer, audience: 'app-a' });
    expect(idClaims.login_context).toBe('customer-team');
  });

  it('keeps another client context out of an app-a token', async () => {
    const tokens = await issueTokens({
      clientId: 'app-b',
      sessionId: state.sessions.member,
      loginContext: 'partner-portal',
    });
    const claims = await verifyAccess(tokens.access_token, 'app-b');
    expect(claims.login_context).toBe('partner-portal');
    expect(claims.roles).toEqual(['app-b:member']);
    expect(claims.permissions).toEqual(['app-b:secret:read']);
    expect(claims.roles).not.toContain('app-a:member');
    expect(claims.permissions).not.toContain('app-a:contact:read');
  });

  it('returns context-specific roles from userinfo', async () => {
    const at = Math.floor(Date.now() / 1000);
    const userinfoFor = async (loginContext: string): Promise<request.Response> => {
      const token = await keys.signAccessToken(
        {
          scope: 'openid',
          client_id: 'app-a',
          token_use: 'access',
          auth_time: at,
          login_context: loginContext,
          permissions_source: 'userinfo',
        },
        {
          issuer,
          audience: 'app-a',
          subject: state.users.member,
          expiresInSeconds: 300,
        },
      );
      return request(app.server).get('/oauth2/userinfo').set('Authorization', `Bearer ${token}`);
    };

    const adminInfo = await userinfoFor('customer-admin');
    expect(adminInfo.status).toBe(200);
    expect(adminInfo.body.sub).toBe(state.users.member);
    expect(adminInfo.body.roles).toEqual(['app-a:editor']);
    expect(adminInfo.body.permissions).toEqual(['app-a:contact:write']);
    expect(adminInfo.body.membership).toEqual({
      context: 'customer-admin',
      status: 'active',
      attributes: { companyId: 'c-42' },
    });

    const teamInfo = await userinfoFor('customer-team');
    expect(teamInfo.status).toBe(200);
    expect(teamInfo.body.roles).toEqual(['app-a:member']);
    expect(teamInfo.body.permissions).toEqual(['app-a:contact:read']);
    expect(teamInfo.body.membership).toEqual({
      context: 'customer-team',
      status: 'active',
      attributes: { teamId: 't-7' },
    });
  });
});

describe('token endpoint re-checks the context', () => {
  it('refuses to exchange a code after the context was disabled', async () => {
    const location = await authorize({
      clientId: 'app-a',
      sessionId: state.sessions.member,
      loginContext: 'customer-team',
    });
    const code = location.searchParams.get('code') as string;
    const client = await prisma.client.findUniqueOrThrow({ where: { clientId: 'app-a' } });
    await prisma.clientLoginContext.update({
      where: { clientId_key: { clientId: client.id, key: 'customer-team' } },
      data: { status: 'disabled' },
    });

    try {
      const response = await exchangeCode({ clientId: 'app-a', code });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('access_denied');
      expect(response.body.access_token).toBeUndefined();

      // The code is single-use even when the context check fails.
      const replay = await exchangeCode({ clientId: 'app-a', code });
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe('invalid_grant');
    } finally {
      await prisma.clientLoginContext.update({
        where: { clientId_key: { clientId: client.id, key: 'customer-team' } },
        data: { status: 'active' },
      });
    }
  });

  it('refuses to exchange a code after the context membership was suspended', async () => {
    const location = await authorize({
      clientId: 'app-a',
      sessionId: state.sessions.revocable,
      loginContext: 'customer-team',
    });
    const code = location.searchParams.get('code') as string;
    const client = await prisma.client.findUniqueOrThrow({ where: { clientId: 'app-a' } });
    const context = await prisma.clientLoginContext.findUniqueOrThrow({
      where: { clientId_key: { clientId: client.id, key: 'customer-team' } },
    });
    const membership = await prisma.clientMembership.findUniqueOrThrow({
      where: {
        clientId_loginContextId_userId: {
          clientId: client.id,
          loginContextId: context.id,
          userId: state.users.revocable,
        },
      },
    });
    await prisma.clientMembership.update({
      where: { id: membership.id },
      data: { status: 'suspended' },
    });

    try {
      const response = await exchangeCode({ clientId: 'app-a', code });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('access_denied');
      expect(response.body.access_token).toBeUndefined();
    } finally {
      await prisma.clientMembership.update({
        where: { id: membership.id },
        data: { status: 'active' },
      });
    }
  });

  it('keeps the context across refresh rotations and ignores a context swap', async () => {
    const tokens = await issueTokens({
      clientId: 'app-a',
      sessionId: state.sessions.member,
      loginContext: 'customer-team',
      scope: 'openid offline_access',
    });
    expect(tokens.refresh_token).toEqual(expect.any(String));

    const first = await refreshToken({
      clientId: 'app-a',
      token: tokens.refresh_token as string,
      // A caller cannot move a refresh token into another context.
      loginContext: 'customer-admin',
    });
    expect(first.status).toBe(200);
    const firstClaims = await verifyAccess(first.body.access_token, 'app-a');
    expect(firstClaims.login_context).toBe('customer-team');
    expect(firstClaims.roles).toEqual(['app-a:member']);
    expect(firstClaims.permissions).toEqual(['app-a:contact:read']);

    // The successor handed to the client must carry the original context in storage too.
    const stored = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(first.body.refresh_token) },
      select: { loginContext: true },
    });
    expect(stored.loginContext).toBe('customer-team');

    // The successor must still be context-bound, otherwise the next refresh would widen.
    const second = await refreshToken({
      clientId: 'app-a',
      token: first.body.refresh_token,
      loginContext: 'customer-admin',
    });
    expect(second.status).toBe(200);
    const secondClaims = await verifyAccess(second.body.access_token, 'app-a');
    expect(secondClaims.login_context).toBe('customer-team');
    expect(secondClaims.roles).toEqual(['app-a:member']);
    expect(secondClaims.membership).toMatchObject({ context: 'customer-team' });
  });

  it('revokes the refresh family when the context membership is suspended', async () => {
    const tokens = await issueTokens({
      clientId: 'app-a',
      sessionId: state.sessions.revocable,
      loginContext: 'customer-team',
      scope: 'openid offline_access',
    });
    const client = await prisma.client.findUniqueOrThrow({ where: { clientId: 'app-a' } });
    const context = await prisma.clientLoginContext.findUniqueOrThrow({
      where: { clientId_key: { clientId: client.id, key: 'customer-team' } },
    });
    const membership = await prisma.clientMembership.findUniqueOrThrow({
      where: {
        clientId_loginContextId_userId: {
          clientId: client.id,
          loginContextId: context.id,
          userId: state.users.revocable,
        },
      },
    });
    await prisma.clientMembership.update({
      where: { id: membership.id },
      data: { status: 'suspended' },
    });

    try {
      const response = await refreshToken({
        clientId: 'app-a',
        token: tokens.refresh_token as string,
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_grant');
      expect(response.body.access_token).toBeUndefined();

      const rows = await prisma.refreshToken.findMany({
        where: { userId: state.users.revocable },
        select: { revokedAt: true },
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    } finally {
      await prisma.clientMembership.update({
        where: { id: membership.id },
        data: { status: 'active' },
      });
    }
  });

  it('fails closed when no context source is wired for a context-bound code', async () => {
    // The production server always wires the source; this guards a misconfigured builder.
    const bare = buildServer({
      issuer,
      keys,
      token: {
        clients: createPrismaClientRepository(prisma),
        codes: createPrismaCodeRepository(prisma),
        refreshTokens: createPrismaRefreshTokenRepository(prisma),
        users: createPrismaUserRepository(prisma),
        sessions: {
          async read(sid) {
            return sessionMap.get(sid) ?? null;
          },
        },
        access: createPrismaEffectiveAccessSource(prisma),
      },
    });
    await bare.ready();
    try {
      const location = await authorize({
        clientId: 'app-a',
        sessionId: state.sessions.member,
        loginContext: 'customer-team',
      });
      const code = location.searchParams.get('code') as string;
      const response = await request(bare.server).post('/oauth2/token').send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI['app-a'],
        client_id: 'app-a',
        code_verifier: verifier,
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('access_denied');
      expect(response.body.access_token).toBeUndefined();
    } finally {
      await bare.close();
    }
  });
});
