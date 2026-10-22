import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaMemberRepository } from '../src/admin/members/prisma-member-repository.js';
import { createPrismaLoginContextRepository } from '../src/admin/login-contexts/prisma-login-context-repository.js';
import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaRbacRepository } from '../src/admin/rbac/prisma-rbac-repository.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createAuthorizeMembershipStatus } from '../src/oidc/authorize-enforcement.js';
import { s256Challenge } from '../src/oidc/authorization-code.js';
import { createPrismaEffectiveAccessSource } from '../src/oidc/effective-access.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { createPrismaLoginContextAccessSource } from '../src/oidc/login-context-access.js';
import { createPrismaClientRepository } from '../src/oidc/prisma-client-repository.js';
import { createPrismaCodeRepository } from '../src/oidc/prisma-code-repository.js';
import { createPrismaRefreshTokenRepository } from '../src/oidc/prisma-refresh-repository.js';
import { createPrismaUserRepository } from '../src/oidc/prisma-user-repository.js';
import { buildServer } from '../src/server.js';
import type { ClientSessionRevoker } from '../src/session/revocation.js';
import type { IdpSession } from '../src/session/types.js';

/**
 * Context-scoped memberships and delegated context administration
 * (docs/api.md 3.3.3, docs/login-contexts.md 7.3/8/9, docs/domain-model.md 2.6.2, 3.4).
 *
 * Every positive case is paired with a negative one: the wrong context, a role outside
 * `allowed_roles`, a duplicate membership, a delegated admin reaching another context, and
 * a suspension that must not touch the sibling context. Cross-context attempts are checked
 * twice — `403`/`404` *and* an unchanged database snapshot.
 */

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3300';
const adminClientId = 'admin-panel';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const redirectUri = 'https://app-a.example.com/callback';
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const MEMBER_PERMISSIONS = [
  'idp:client-member:read',
  'idp:client-member:invite',
  'idp:client-member:write',
  'idp:client-role:assign',
  'idp:client-session:read',
];

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let prisma: PrismaClient;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let effectiveAccess: ReturnType<typeof createPrismaEffectiveAccessSource>;

const sessionMap = new Map<string, IdpSession>();
const sessionRevocationCalls: {
  userId: string;
  clientId: string;
  loginContext?: string;
  reason: string;
}[] = [];
/** `sid`s the fake store reports as revoked for the last context suspension. */
let contextRevokedSids: string[] = [];

/** Records the revoker calls so a context suspension is provably context-scoped. */
const sessionRevoker: ClientSessionRevoker = {
  async revokeForUserClient(userId, clientId, reason) {
    sessionRevocationCalls.push({ userId, clientId, reason });
    return 0;
  },
  async revokeForUserClientContext(userId, clientId, loginContext, reason) {
    sessionRevocationCalls.push({ userId, clientId, loginContext, reason });
    return contextRevokedSids;
  },
};

interface Fixtures {
  tenantId: string;
  appAId: string;
  appBId: string;
  users: {
    admin: string;
    delegatedDefault: string;
    delegatedContextAdmin: string;
    delegatedWideMembership: string;
    delegatedNoMembership: string;
  };
  roles: Record<string, string>;
  contexts: { customerAdmin: string; customerTeam: string; partnerPortal: string };
}

let state: Fixtures;

const scope = (clientId: string): string => `/api/v1/clients/${clientId}/login-contexts`;

const membersPath = (clientId: string, contextKey: string): string =>
  `${scope(clientId)}/${contextKey}/members`;

async function sign(userId: string, clientId: string, tokenScope: string): Promise<string> {
  const accessToken = await keys.signAccessToken(
    { scope: tokenScope, client_id: clientId, auth_time: nowSeconds() },
    { issuer, audience: clientId, subject: userId, expiresInSeconds: 300 },
  );
  return 'Bearer ' + accessToken;
}

const globalAuth = (): Promise<string> =>
  sign(state.users.admin, adminClientId, 'openid idp.admin');
const delegatedDefaultAuth = (): Promise<string> =>
  sign(state.users.delegatedDefault, 'app-a', 'openid idp.client-admin');
const delegatedContextAuth = (): Promise<string> =>
  sign(state.users.delegatedContextAdmin, 'app-a', 'openid idp.client-admin');
const delegatedNoMembershipAuth = (): Promise<string> =>
  sign(state.users.delegatedNoMembership, 'app-a', 'openid idp.client-admin');
const delegatedWideMembershipAuth = (): Promise<string> =>
  sign(state.users.delegatedWideMembership, 'app-a', 'openid idp.client-admin');

async function createSession(userId: string): Promise<string> {
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
}

async function issueTokens(
  userId: string,
  loginContext: string,
): Promise<{ access_token: string; refresh_token: string; sid: string }> {
  const sid = await createSession(userId);
  const authorize = await request(app.server)
    .get('/oauth2/authorize')
    .query({
      response_type: 'code',
      client_id: 'app-a',
      redirect_uri: redirectUri,
      scope: 'openid offline_access',
      state: 'state-1',
      nonce: 'nonce-1',
      code_challenge: s256Challenge(verifier),
      code_challenge_method: 'S256',
      login_context: loginContext,
    })
    .set('Cookie', `idpn_session=${sid}`)
    .expect(302);
  const location = new URL(authorize.headers.location as string);
  expect(location.searchParams.get('error')).toBeNull();
  const code = location.searchParams.get('code');
  expect(code).toEqual(expect.any(String));

  const response = await request(app.server)
    .post('/oauth2/token')
    .send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: 'app-a',
      code_verifier: verifier,
    })
    .expect(200);
  return { ...(response.body as { access_token: string; refresh_token: string }), sid };
}

async function refresh(refreshToken: string): Promise<request.Response> {
  return request(app.server).post('/oauth2/token').send({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: 'app-a',
  });
}

async function invite(
  contextKey: string,
  body: { email: string; roleKeys?: string[]; attributes?: Record<string, unknown> },
  authorization?: Promise<string>,
): Promise<request.Response> {
  return request(app.server)
    .post(`${membersPath('app-a', contextKey)}/invite`)
    .set('Authorization', await (authorization ?? globalAuth()))
    .send({ roleKeys: [], attributes: {}, ...body });
}

async function membershipRow(
  userId: string,
  loginContextId: string | null,
): Promise<{ id: string; status: string } | null> {
  return prisma.clientMembership.findFirst({
    where: { clientId: state.appAId, userId, loginContextId },
    select: { id: true, status: true },
  });
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_context_members_${Date.now()}`;
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
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionStringValue },
  });
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionStringValue }) });

  keys = new SigningKeyManager(new MemorySigningKeyRepository());
  await keys.ensureKey();

  const permissionReader = createPrismaPermissionReader(prisma);
  const rbac = createPrismaRbacRepository(prisma);
  const clients = createPrismaClientRepository(prisma);
  const users = createPrismaUserRepository(prisma);
  const audit = createPrismaAdminAudit(prisma);
  effectiveAccess = createPrismaEffectiveAccessSource(prisma);

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
    rbac: {
      adminClientId,
      permissions: permissionReader,
      rbac,
      audit,
    },
    adminMembers: {
      adminClientId,
      permissions: permissionReader,
      members: createPrismaMemberRepository(prisma, { rbac, sessions: sessionRevoker }),
      audit,
    },
    adminLoginContexts: {
      adminClientId,
      permissions: permissionReader,
      contexts: createPrismaLoginContextRepository(prisma),
      audit,
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  const createClient = (clientId: string, scopes: string[], uris: string[] = []) =>
    prisma.client.create({
      data: {
        clientId,
        name: clientId,
        type: 'spa',
        redirectUris: uris,
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes,
        tenantId: tenant.id,
      },
    });
  await createClient(adminClientId, ['openid', 'idp.admin']);
  const appA = await createClient(
    'app-a',
    ['openid', 'idp.client-admin', 'offline_access'],
    [redirectUri],
  );
  const appB = await createClient('app-b', ['openid', 'idp.client-admin']);

  const createPermission = (key: string, clientId: string | null) =>
    prisma.permission.create({ data: { key, description: key, clientId } });
  const memberPermissions: { id: string }[] = [];
  for (const key of MEMBER_PERMISSIONS) {
    memberPermissions.push(await createPermission(key, null));
  }
  const contextRead = await createPermission('idp:client-context:read', null);
  const contextWrite = await createPermission('idp:client-context:write', null);
  const contactRead = await createPermission('app-a:contact:read', appA.id);
  const contactWrite = await createPermission('app-a:contact:write', appA.id);
  const teamRead = await createPermission('app-a:team:read', appA.id);
  const appBRead = await createPermission('app-b:secret:read', appB.id);
  const userRead = await createPermission('idp:user:read', null);

  const createRole = (
    key: string,
    clientId: string | null,
    permissions: { id: string }[],
    isDefault = false,
  ) =>
    prisma.role.create({
      data: {
        key,
        name: key,
        description: key,
        clientId,
        isDefault,
        rolePermissions: { create: permissions.map((entry) => ({ permissionId: entry.id })) },
      },
      select: { id: true },
    });

  const roles: Record<string, string> = {};
  roles['membership-admin'] = (
    await createRole('membership-admin', null, [
      ...memberPermissions,
      { id: contextRead.id },
      { id: contextWrite.id },
    ])
  ).id;
  roles['app-a:user-admin'] = (await createRole('app-a:user-admin', appA.id, memberPermissions)).id;
  roles['app-a:context-admin-customer-admin'] = (
    await createRole('app-a:context-admin-customer-admin', appA.id, memberPermissions)
  ).id;
  roles['app-a:member'] = (await createRole('app-a:member', appA.id, [contactRead], true)).id;
  roles['app-a:customer-admin'] = (
    await createRole('app-a:customer-admin', appA.id, [contactWrite])
  ).id;
  roles['app-a:customer-team'] = (await createRole('app-a:customer-team', appA.id, [teamRead])).id;
  roles['app-a:manager'] = (await createRole('app-a:manager', appA.id, [])).id;
  roles['app-b:member'] = (await createRole('app-b:member', appB.id, [appBRead])).id;
  roles['idp:superadmin'] = (await createRole('idp:superadmin', null, [userRead])).id;

  const createContext = (
    clientId: string,
    key: string,
    allowedRoles: string[],
    defaultRoles: string[],
    isDefault = false,
  ) =>
    prisma.clientLoginContext.create({
      data: {
        clientId,
        key,
        name: key,
        allowedRoles,
        defaultRoles,
        loginMethods: ['password'],
        isDefault,
        sessionIdleTtl: 1800,
        sessionAbsoluteTtl: 28_800,
      },
      select: { id: true },
    });
  const customerAdmin = await createContext(
    appA.id,
    'customer-admin',
    ['app-a:customer-admin', 'app-a:member'],
    ['app-a:member'],
    true,
  );
  const customerTeam = await createContext(
    appA.id,
    'customer-team',
    ['app-a:customer-team'],
    ['app-a:customer-team'],
  );
  const partnerPortal = await createContext(appB.id, 'partner-portal', ['app-b:member'], []);

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
  const admin = await createUser('admin');
  const delegatedDefault = await createUser('delegated-default');
  const delegatedContextAdmin = await createUser('delegated-context');
  const delegatedWide = await createUser('delegated-wide');
  const delegatedNoMembership = await createUser('delegated-no-membership');

  const assign = (userId: string, roleId: string) =>
    prisma.assignment.create({
      data: {
        subjectType: 'user',
        subjectId: userId,
        roleId,
        scopeType: 'global',
        assignedBy: admin.id,
      },
    });
  await assign(admin.id, roles['membership-admin']!);
  await assign(delegatedDefault.id, roles['app-a:user-admin']!);
  await assign(delegatedContextAdmin.id, roles['app-a:context-admin-customer-admin']!);
  await assign(delegatedWide.id, roles['app-a:context-admin-customer-admin']!);
  await assign(delegatedNoMembership.id, roles['app-a:user-admin']!);

  const addActiveMembership = (
    userId: string,
    loginContextId: string | null,
    clientId: string = appA.id,
  ) =>
    prisma.clientMembership.create({
      data: {
        clientId,
        userId,
        loginContextId,
        status: 'active',
        joinedAt: new Date(),
      },
    });
  await addActiveMembership(delegatedDefault.id, null);
  await addActiveMembership(delegatedContextAdmin.id, customerAdmin.id);
  // Holds the customer-admin delegation but is also an ordinary member of customer-team.
  await addActiveMembership(delegatedWide.id, customerAdmin.id);
  await addActiveMembership(delegatedWide.id, customerTeam.id);

  state = {
    tenantId: tenant.id,
    appAId: appA.id,
    appBId: appB.id,
    users: {
      admin: admin.id,
      delegatedDefault: delegatedDefault.id,
      delegatedContextAdmin: delegatedContextAdmin.id,
      delegatedWideMembership: delegatedWide.id,
      delegatedNoMembership: delegatedNoMembership.id,
    },
    roles,
    contexts: {
      customerAdmin: customerAdmin.id,
      customerTeam: customerTeam.id,
      partnerPortal: partnerPortal.id,
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

describe('context membership keying', () => {
  it('lets one user hold independent memberships in two contexts of the same app', async () => {
    const adminInvite = await invite('customer-admin', {
      email: 'multi-context@example.com',
      roleKeys: ['app-a:customer-admin'],
      attributes: { department: 'sales' },
    });
    expect(adminInvite.status).toBe(201);
    const userId = adminInvite.body.member.userId as string;
    expect(adminInvite.body.member).toMatchObject({
      loginContextKey: 'customer-admin',
      status: 'invited',
      roleKeys: ['app-a:customer-admin', 'app-a:member'],
    });

    const teamInvite = await invite('customer-team', {
      email: 'multi-context@example.com',
      roleKeys: [],
      attributes: { teamId: 't-7' },
    });
    expect(teamInvite.status).toBe(201);
    expect(teamInvite.body.member.userId).toBe(userId);
    expect(teamInvite.body.member).toMatchObject({
      loginContextKey: 'customer-team',
      roleKeys: ['app-a:customer-team'],
      attributes: { teamId: 't-7' },
    });
    expect(teamInvite.body.createdUser).toBe(false);

    const rows = await prisma.clientMembership.findMany({
      where: { clientId: state.appAId, userId },
      select: { loginContextId: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.loginContextId).sort()).toEqual(
      [state.contexts.customerAdmin, state.contexts.customerTeam].sort(),
    );

    // The client-wide membership was not created as a side effect.
    expect(await membershipRow(userId, null)).toBeNull();

    const adminList = await request(app.server)
      .get(membersPath('app-a', 'customer-admin'))
      .set('Authorization', await globalAuth())
      .expect(200);
    const teamList = await request(app.server)
      .get(membersPath('app-a', 'customer-team'))
      .set('Authorization', await globalAuth())
      .expect(200);
    expect(adminList.body.items.map((item: { userId: string }) => item.userId)).toContain(userId);
    expect(teamList.body.items.map((item: { userId: string }) => item.userId)).toContain(userId);

    // A member of one context is invisible in the list of the other context.
    await invite('customer-team', { email: 'team-only@example.com', roleKeys: [] });
    const after = await request(app.server)
      .get(membersPath('app-a', 'customer-admin'))
      .set('Authorization', await globalAuth())
      .expect(200);
    expect(after.body.items.map((item: { email: string }) => item.email)).not.toContain(
      'team-only@example.com',
    );
  });

  it('keeps a default membership independent from a context membership', async () => {
    const defaultInvite = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', await globalAuth())
      .send({ email: 'default-and-context@example.com', roleKeys: [], attributes: {} })
      .expect(201);
    const userId = defaultInvite.body.member.userId as string;
    expect(defaultInvite.body.member.loginContextKey).toBeNull();

    const contextInvite = await invite('customer-team', {
      email: 'default-and-context@example.com',
      roleKeys: [],
    });
    expect(contextInvite.status).toBe(201);
    expect(contextInvite.body.member.userId).toBe(userId);

    expect(await membershipRow(userId, null)).not.toBeNull();
    expect(await membershipRow(userId, state.contexts.customerTeam)).not.toBeNull();

    await request(app.server)
      .get(`/api/v1/clients/app-a/members/${userId}`)
      .set('Authorization', await globalAuth())
      .expect(200);
    await request(app.server)
      .get(`${membersPath('app-a', 'customer-team')}/${userId}`)
      .set('Authorization', await globalAuth())
      .expect(200);
  });

  it('rejects a duplicate context membership with 409 and keeps the first one', async () => {
    const first = await invite('customer-admin', { email: 'duplicate@example.com', roleKeys: [] });
    expect(first.status).toBe(201);
    const userId = first.body.member.userId as string;

    const duplicate = await invite('customer-admin', {
      email: 'duplicate@example.com',
      roleKeys: ['app-a:customer-admin'],
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.detail).toContain('already a member');

    const rows = await prisma.clientMembership.findMany({
      where: { clientId: state.appAId, userId },
      select: { id: true, status: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('invited');
  });

  it('rejects roles outside allowed_roles, unknown roles, foreign roles and idp roles', async () => {
    const cases = [
      { email: 'outside@example.com', roleKeys: ['app-a:manager'] },
      { email: 'unknown@example.com', roleKeys: ['app-a:ghost'] },
      { email: 'foreign@example.com', roleKeys: ['app-b:member'] },
      { email: 'global@example.com', roleKeys: ['idp:superadmin'] },
    ];
    for (const testCase of cases) {
      const response = await invite('customer-admin', testCase);
      expect(response.status).toBe(422);
      expect(response.body.detail).toBeDefined();
      expect(
        await prisma.user.findFirst({
          where: { tenantId: state.tenantId, email: testCase.email },
          select: { id: true },
        }),
      ).toBeNull();
    }

    const outside = await invite('customer-admin', {
      email: 'outside-detail@example.com',
      roleKeys: ['app-a:manager'],
    });
    expect(outside.body.detail).toContain('not allowed in this login context');
  });

  it('applies the context default roles on the first membership only', async () => {
    const response = await invite('customer-team', {
      email: 'defaults@example.com',
      roleKeys: [],
    });
    expect(response.status).toBe(201);
    expect(response.body.member.roleKeys).toEqual(['app-a:customer-team']);

    const userId = response.body.member.userId as string;
    const assignments = await prisma.assignment.findMany({
      where: {
        subjectType: 'user',
        subjectId: userId,
        roleId: { in: [state.roles['app-a:member']!, state.roles['app-a:customer-team']!] },
      },
      select: { roleId: true },
    });
    expect(assignments.map((row) => row.roleId)).toEqual([state.roles['app-a:customer-team']]);
  });

  it('returns 404 for a context that belongs to another client', async () => {
    const response = await invite('partner-portal', { email: 'cross-client@example.com' });
    expect(response.status).toBe(404);
    expect(response.body.detail).toContain('does not exist');
  });

  it('returns 404 for an unknown context on every context endpoint', async () => {
    const authorization = await globalAuth();
    const path = membersPath('app-a', 'ghost-context');
    const requests = [
      request(app.server).get(path).set('Authorization', authorization),
      request(app.server)
        .post(`${path}/invite`)
        .set('Authorization', authorization)
        .send({ email: 'ghost@example.com' }),
      request(app.server)
        .get(`${path}/${state.users.delegatedDefault}`)
        .set('Authorization', authorization),
      request(app.server)
        .patch(`${path}/${state.users.delegatedDefault}`)
        .set('Authorization', authorization)
        .send({ status: 'active' }),
      request(app.server)
        .delete(`${path}/${state.users.delegatedDefault}`)
        .set('Authorization', authorization),
      request(app.server)
        .put(`${path}/${state.users.delegatedDefault}/roles`)
        .set('Authorization', authorization)
        .send({ roleKeys: [] }),
    ];
    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(404);
    }
  });
});

describe('role isolation per context', () => {
  it('replaces the roles of one context without touching the other context', async () => {
    const adminInvite = await invite('customer-admin', {
      email: 'role-isolation@example.com',
      roleKeys: ['app-a:customer-admin'],
    });
    const userId = adminInvite.body.member.userId as string;
    await invite('customer-team', { email: 'role-isolation@example.com', roleKeys: [] });

    const replaced = await request(app.server)
      .put(`${membersPath('app-a', 'customer-admin')}/${userId}/roles`)
      .set('Authorization', await globalAuth())
      .send({ roleKeys: ['app-a:member'] })
      .expect(200);
    expect(replaced.body.roleKeys).toEqual(['app-a:member']);

    const team = await request(app.server)
      .get(`${membersPath('app-a', 'customer-team')}/${userId}`)
      .set('Authorization', await globalAuth())
      .expect(200);
    expect(team.body.roleKeys).toEqual(['app-a:customer-team']);

    const admin = await request(app.server)
      .get(`${membersPath('app-a', 'customer-admin')}/${userId}`)
      .set('Authorization', await globalAuth())
      .expect(200);
    expect(admin.body.roleKeys).toEqual(['app-a:member']);

    // Effective access is drawn from the context membership: an invited membership grants
    // nothing, an active one grants exactly the roles of that context.
    const invitedAccess = await effectiveAccess.resolve({
      userId,
      clientId: 'app-a',
      loginContext: 'customer-admin',
    });
    expect(invitedAccess.roles).toEqual([]);
    expect(invitedAccess.membership?.status).toBe('invited');

    for (const key of ['customer-admin', 'customer-team']) {
      await request(app.server)
        .patch(`${membersPath('app-a', key)}/${userId}`)
        .set('Authorization', await globalAuth())
        .send({ status: 'active' })
        .expect(200);
    }

    const adminAccess = await effectiveAccess.resolve({
      userId,
      clientId: 'app-a',
      loginContext: 'customer-admin',
    });
    expect(adminAccess.roles).toEqual(['app-a:member']);
    expect(adminAccess.permissions).toEqual(['app-a:contact:read']);

    const teamAccess = await effectiveAccess.resolve({
      userId,
      clientId: 'app-a',
      loginContext: 'customer-team',
    });
    expect(teamAccess.roles).toEqual(['app-a:customer-team']);
    expect(teamAccess.permissions).toEqual(['app-a:team:read']);
  });

  it('rejects a role outside the context with 422 and changes no assignment', async () => {
    const invited = await invite('customer-team', {
      email: 'roles-rejected@example.com',
      roleKeys: [],
    });
    const userId = invited.body.member.userId as string;
    const before = await prisma.assignment.findMany({
      where: { subjectType: 'user', subjectId: userId },
      select: { roleId: true },
    });

    const response = await request(app.server)
      .put(`${membersPath('app-a', 'customer-team')}/${userId}/roles`)
      .set('Authorization', await globalAuth())
      .send({ roleKeys: ['app-a:manager'] });
    expect(response.status).toBe(422);
    expect(response.body.detail).toContain('not allowed in this login context');

    const after = await prisma.assignment.findMany({
      where: { subjectType: 'user', subjectId: userId },
      select: { roleId: true },
    });
    expect(after).toEqual(before);
  });

  it('shows only context roles in the admin representation', async () => {
    // The user also holds a role that this context cannot grant; it must stay out of the
    // context view but remain assigned for the context that owns it.
    const invited = await invite('customer-admin', {
      email: 'hidden-role@example.com',
      roleKeys: ['app-a:customer-admin'],
    });
    const userId = invited.body.member.userId as string;
    await prisma.assignment.create({
      data: {
        subjectType: 'user',
        subjectId: userId,
        roleId: state.roles['app-a:manager']!,
        scopeType: 'global',
        assignedBy: state.users.admin,
      },
    });

    const response = await request(app.server)
      .get(`${membersPath('app-a', 'customer-admin')}/${userId}`)
      .set('Authorization', await globalAuth())
      .expect(200);
    expect(response.body.roleKeys).toEqual(['app-a:customer-admin', 'app-a:member']);
    expect(response.body.roleKeys).not.toContain('app-a:manager');
  });
});

describe('context membership removal', () => {
  it('removes one context membership, its roles and nothing else', async () => {
    const adminInvite = await invite('customer-admin', {
      email: 'removal@example.com',
      roleKeys: ['app-a:customer-admin'],
    });
    const userId = adminInvite.body.member.userId as string;
    await invite('customer-team', { email: 'removal@example.com', roleKeys: [] });

    await request(app.server)
      .delete(`${membersPath('app-a', 'customer-admin')}/${userId}`)
      .set('Authorization', await globalAuth())
      .expect(204);

    expect(await membershipRow(userId, state.contexts.customerAdmin)).toBeNull();
    expect(await membershipRow(userId, state.contexts.customerTeam)).not.toBeNull();
    await expect(
      prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
    ).resolves.not.toBeNull();

    const roles = await prisma.assignment.findMany({
      where: { subjectType: 'user', subjectId: userId },
      select: { roleId: true },
    });
    expect(roles.map((row) => row.roleId)).toEqual([state.roles['app-a:customer-team']]);

    const team = await request(app.server)
      .get(`${membersPath('app-a', 'customer-team')}/${userId}`)
      .set('Authorization', await globalAuth())
      .expect(200);
    expect(team.body.loginContextKey).toBe('customer-team');
  });

  it('returns 404 when the context membership is already gone', async () => {
    const invited = await invite('customer-team', { email: 'removal-twice@example.com' });
    const userId = invited.body.member.userId as string;

    await request(app.server)
      .delete(`${membersPath('app-a', 'customer-team')}/${userId}`)
      .set('Authorization', await globalAuth())
      .expect(204);
    await request(app.server)
      .delete(`${membersPath('app-a', 'customer-team')}/${userId}`)
      .set('Authorization', await globalAuth())
      .expect(404);
    await request(app.server)
      .get(`${membersPath('app-a', 'customer-admin')}/${userId}`)
      .set('Authorization', await globalAuth())
      .expect(404);
  });
});

describe('context suspension', () => {
  it('suspends one context and revokes only that context credentials', async () => {
    const adminInvite = await invite('customer-admin', {
      email: 'suspend-isolation@example.com',
      roleKeys: [],
    });
    const userId = adminInvite.body.member.userId as string;
    await invite('customer-team', { email: 'suspend-isolation@example.com', roleKeys: [] });

    for (const key of ['customer-admin', 'customer-team']) {
      await request(app.server)
        .patch(`${membersPath('app-a', key)}/${userId}`)
        .set('Authorization', await globalAuth())
        .send({ status: 'active' })
        .expect(200);
    }

    const adminTokens = await issueTokens(userId, 'customer-admin');
    const teamTokens = await issueTokens(userId, 'customer-team');

    // The store reports the exact sids it revoked; the repository must mirror them.
    contextRevokedSids = [adminTokens.sid];
    sessionRevocationCalls.length = 0;
    const suspended = await request(app.server)
      .patch(`${membersPath('app-a', 'customer-admin')}/${userId}`)
      .set('Authorization', await globalAuth())
      .send({ status: 'suspended' })
      .expect(200);
    expect(suspended.body.status).toBe('suspended');
    contextRevokedSids = [];

    expect(await membershipRow(userId, state.contexts.customerAdmin)).toMatchObject({
      status: 'suspended',
    });
    expect(await membershipRow(userId, state.contexts.customerTeam)).toMatchObject({
      status: 'active',
    });

    // Only the context-scoped revoker ran; the client-wide one would cut the other context.
    expect(sessionRevocationCalls).toEqual([
      {
        userId,
        clientId: 'app-a',
        loginContext: 'customer-admin',
        reason: 'admin',
      },
    ]);

    const tokens = await prisma.refreshToken.findMany({
      where: { clientId: state.appAId, userId },
      select: { loginContext: true, revokedAt: true },
    });
    for (const row of tokens) {
      if (row.loginContext === 'customer-admin') {
        expect(row.revokedAt).not.toBeNull();
      } else {
        expect(row.revokedAt).toBeNull();
      }
    }

    // Only the mirrored session of the suspended context is revoked in PostgreSQL.
    const suspendedSession = await prisma.session.findUniqueOrThrow({
      where: { id: adminTokens.sid },
      select: { revokedAt: true, revokeReason: true },
    });
    expect(suspendedSession.revokedAt).not.toBeNull();
    expect(suspendedSession.revokeReason).toBe('membership_suspend');
    const otherSession = await prisma.session.findUniqueOrThrow({
      where: { id: teamTokens.sid },
      select: { revokedAt: true },
    });
    expect(otherSession.revokedAt).toBeNull();

    const denied = await refresh(adminTokens.refresh_token);
    expect(denied.status).toBe(400);
    expect(denied.body.access_token).toBeUndefined();

    const allowed = await refresh(teamTokens.refresh_token);
    expect(allowed.status).toBe(200);
    expect(allowed.body.access_token).toEqual(expect.any(String));
    const claims = await keys.verify(allowed.body.access_token, {
      issuer,
      audience: 'app-a',
    });
    expect(claims.login_context).toBe('customer-team');
    expect(claims.roles).toEqual(['app-a:customer-team']);
  });
});

describe('delegated context administration', () => {
  it('lets a context admin manage its own context', async () => {
    const list = await request(app.server)
      .get(membersPath('app-a', 'customer-admin'))
      .set('Authorization', await delegatedContextAuth())
      .expect(200);
    expect(list.body.items.length).toBeGreaterThan(0);

    const invited = await invite(
      'customer-admin',
      { email: 'managed-by-context-admin@example.com', roleKeys: [] },
      delegatedContextAuth(),
    );
    expect(invited.status).toBe(201);
    const userId = invited.body.member.userId as string;

    const patched = await request(app.server)
      .patch(`${membersPath('app-a', 'customer-admin')}/${userId}`)
      .set('Authorization', await delegatedContextAuth())
      .send({ status: 'active' })
      .expect(200);
    expect(patched.body.status).toBe('active');
  });

  it('denies another context of the same client on every endpoint and writes nothing', async () => {
    const invited = await invite('customer-team', {
      email: 'cross-context-target@example.com',
      roleKeys: [],
    });
    const userId = invited.body.member.userId as string;
    const before = await prisma.clientMembership.findFirstOrThrow({
      where: { clientId: state.appAId, userId, loginContextId: state.contexts.customerTeam },
      select: { status: true, attributes: true, updatedAt: true },
    });
    const path = membersPath('app-a', 'customer-team');
    const authorization = await delegatedContextAuth();

    const attempts: { name: string; response: request.Response }[] = [];
    attempts.push({
      name: 'list',
      response: await request(app.server).get(path).set('Authorization', authorization),
    });
    attempts.push({
      name: 'invite',
      response: await request(app.server)
        .post(`${path}/invite`)
        .set('Authorization', authorization)
        .send({ email: 'cross-context-invite@example.com', roleKeys: [] }),
    });
    attempts.push({
      name: 'read',
      response: await request(app.server)
        .get(`${path}/${userId}`)
        .set('Authorization', authorization),
    });
    attempts.push({
      name: 'patch',
      response: await request(app.server)
        .patch(`${path}/${userId}`)
        .set('Authorization', authorization)
        .send({ status: 'suspended' }),
    });
    attempts.push({
      name: 'delete',
      response: await request(app.server)
        .delete(`${path}/${userId}`)
        .set('Authorization', authorization),
    });
    attempts.push({
      name: 'roles',
      response: await request(app.server)
        .put(`${path}/${userId}/roles`)
        .set('Authorization', authorization)
        .send({ roleKeys: ['app-a:customer-team'] }),
    });

    for (const attempt of attempts) {
      expect(attempt.response.status, attempt.name).toBe(403);
    }

    const after = await prisma.clientMembership.findFirstOrThrow({
      where: { clientId: state.appAId, userId, loginContextId: state.contexts.customerTeam },
      select: { status: true, attributes: true, updatedAt: true },
    });
    expect(after).toEqual(before);
    expect(
      await prisma.user.findFirst({
        where: { tenantId: state.tenantId, email: 'cross-context-invite@example.com' },
        select: { id: true },
      }),
    ).toBeNull();

    // Another context's key cannot be smuggled into the admin's own path either.
    const foreign = await request(app.server)
      .get(`${membersPath('app-b', 'partner-portal')}`)
      .set('Authorization', authorization);
    expect(foreign.status).toBe(403);

    const denials = await prisma.auditEvent.findMany({
      where: {
        action: 'member.context.denied',
        actorId: state.users.delegatedContextAdmin,
        result: 'failure',
      },
      select: { clientId: true, metadata: true },
    });
    expect(denials.length).toBeGreaterThanOrEqual(attempts.length);
    for (const event of denials) {
      expect(event.clientId).toBe(state.appAId);
      const metadata = event.metadata as Record<string, unknown>;
      expect(metadata['userId']).toBe(state.users.delegatedContextAdmin);
      expect(metadata['reason']).toBe('cross-context');
    }
  });

  it('lets a delegated admin with a client-wide membership manage every context', async () => {
    await request(app.server)
      .get(membersPath('app-a', 'customer-admin'))
      .set('Authorization', await delegatedDefaultAuth())
      .expect(200);
    await request(app.server)
      .get(membersPath('app-a', 'customer-team'))
      .set('Authorization', await delegatedDefaultAuth())
      .expect(200);
  });

  it('does not extend a context-admin role to a context where it is only a member', async () => {
    await request(app.server)
      .get(membersPath('app-a', 'customer-admin'))
      .set('Authorization', await delegatedWideMembershipAuth())
      .expect(200);

    const denied = await request(app.server)
      .get(membersPath('app-a', 'customer-team'))
      .set('Authorization', await delegatedWideMembershipAuth());
    expect(denied.status).toBe(403);
  });

  it('denies a delegated admin without a membership for the client', async () => {
    const response = await request(app.server)
      .get(membersPath('app-a', 'customer-admin'))
      .set('Authorization', await delegatedNoMembershipAuth());
    expect(response.status).toBe(403);

    // The client-wide membership surface keeps its previous behavior.
    await request(app.server)
      .get('/api/v1/clients/app-a/members')
      .set('Authorization', await delegatedNoMembershipAuth())
      .expect(200);
  });

  it('does not let a context admin change the context policy', async () => {
    const response = await request(app.server)
      .patch(`${scope('app-a')}/customer-admin`)
      .set('Authorization', await delegatedContextAuth())
      .send({ allowedRoles: ['app-a:manager'] });
    expect(response.status).toBe(403);

    const stored = await prisma.clientLoginContext.findFirstOrThrow({
      where: { clientId: state.appAId, key: 'customer-admin' },
      select: { allowedRoles: true },
    });
    expect(stored.allowedRoles).not.toContain('app-a:manager');
  });
});

describe('audit trail', () => {
  it('records every context mutation with clientId and context key', async () => {
    const invited = await invite('customer-admin', {
      email: 'audited@example.com',
      roleKeys: [],
    });
    const userId = invited.body.member.userId as string;
    const path = membersPath('app-a', 'customer-admin');

    await request(app.server)
      .put(`${path}/${userId}/roles`)
      .set('Authorization', await globalAuth())
      .send({ roleKeys: ['app-a:member'] })
      .expect(200);
    await request(app.server)
      .patch(`${path}/${userId}`)
      .set('Authorization', await globalAuth())
      .send({ status: 'suspended' })
      .expect(200);
    await request(app.server)
      .delete(`${path}/${userId}`)
      .set('Authorization', await globalAuth())
      .expect(204);

    const events = await prisma.auditEvent.findMany({
      where: {
        actorId: state.users.admin,
        action: {
          in: ['member.invite', 'member.roles.replace', 'member.suspend', 'member.remove'],
        },
        clientId: state.appAId,
      },
      select: { action: true, targetType: true, result: true, metadata: true },
    });
    const forUser = events.filter(
      (event) => (event.metadata as Record<string, unknown>)['userId'] === userId,
    );
    const byAction = new Map(forUser.map((event) => [event.action, event]));
    for (const action of [
      'member.invite',
      'member.roles.replace',
      'member.suspend',
      'member.remove',
    ]) {
      const event = byAction.get(action);
      expect(event, action).toBeDefined();
      expect(event?.result).toBe('success');
      expect(event?.targetType).toBe('membership');
      const metadata = event?.metadata as Record<string, unknown>;
      expect(metadata['loginContext']).toBe('customer-admin');
      expect(metadata['userId']).toBe(userId);
    }
  });
});
