import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaMemberRepository } from '../src/admin/members/prisma-member-repository.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { createPrismaRbacRepository } from '../src/admin/rbac/prisma-rbac-repository.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type { AuthorizationCodeRecord } from '../src/oidc/authorization-code.js';
import { s256Challenge } from '../src/oidc/authorization-code.js';
import { createAuthorizeMembershipStatus } from '../src/oidc/authorize-enforcement.js';
import { createPrismaEffectiveAccessSource } from '../src/oidc/effective-access.js';
import { createPrismaLoginContextAccessSource } from '../src/oidc/login-context-access.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { createPrismaClientRepository } from '../src/oidc/prisma-client-repository.js';
import { createPrismaCodeRepository } from '../src/oidc/prisma-code-repository.js';
import { createPrismaRefreshTokenRepository } from '../src/oidc/prisma-refresh-repository.js';
import { createPrismaUserRepository } from '../src/oidc/prisma-user-repository.js';
import { hashRefreshToken } from '../src/oidc/refresh-token.js';
import { buildAccessTokenClaims } from '../src/oidc/token-claims.js';
import { buildServer } from '../src/server.js';
import type { IdpSession } from '../src/session/types.js';

/**
 * Cross-client RBAC and membership regression matrix (docs/testing.md INT-RBAC-001..003,
 * INT-MEMBER-002, docs/security.md 6.1).
 *
 * The value of this suite is that every delegated cross-client attempt is checked twice:
 * the response must be 403/404 *and* a database snapshot of the victim client must be
 * byte-identical afterwards. A regression that only hides data but still writes it fails.
 */

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3100';
const adminClientId = 'admin-panel';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

type AppClientId = 'app-a' | 'app-b';

const REDIRECT_URI: Record<AppClientId, string> = {
  'app-a': 'https://app-a.example.com/callback',
  'app-b': 'https://app-b.example.com/callback',
};

const GLOBAL_PERMISSIONS = [
  'idp:role:read',
  'idp:role:write',
  'idp:client-role:read',
  'idp:client-role:write',
  'idp:client-role:assign',
  'idp:client-member:read',
  'idp:client-member:invite',
  'idp:client-member:write',
  'idp:client-session:read',
  'idp:user:read',
];

const BULK_PERMISSION_COUNT = 60;

interface AppFixture {
  internalId: string;
  memberRoleId: string;
  userAdminRoleId: string;
}

interface Fixtures {
  adminUserId: string;
  delegated: Record<AppClientId, string>;
  memberUserId: string;
  memberBOnlyId: string;
  bulkUserId: string;
  scopeUserId: string;
  scopeUserAssignmentId: string;
  globalTargetId: string;
  targets: Record<AppClientId, string>;
  permissionIds: Record<AppClientId, string>;
  apps: Record<AppClientId, AppFixture>;
  sessions: { member: string; bulk: string; scope: string };
  bulkPermissionKeys: string[];
}

interface AppSnapshot {
  permissions: string[];
  roles: { key: string; permissions: string[] }[];
  memberships: { userId: string; status: string; contextId: string | null }[];
  assignments: { roleId: string; subjectId: string; expiresAt: string | null }[];
  refreshTokens: { active: number; revoked: number };
  users: number;
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
let usersRepository: ReturnType<typeof createPrismaUserRepository>;
let effectiveAccess: ReturnType<typeof createPrismaEffectiveAccessSource>;
let state: Fixtures;

const sessionMap = new Map<string, IdpSession>();

const connectionString = (): string => connectionStringValue;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

async function verifyAccess(token: string, audience: string): Promise<Record<string, unknown>> {
  return keys.verify(token, { issuer, audience });
}

async function signDelegatedToken(
  clientId: AppClientId,
  userId: string,
  options: { audience?: string; authTime?: number; scope?: string } = {},
): Promise<string> {
  const token = await keys.signAccessToken(
    {
      scope: options.scope ?? 'openid idp.client-admin',
      client_id: clientId,
      auth_time: options.authTime ?? nowSeconds(),
      acr: 'urn:on4net:acr:mfa',
      amr: ['pwd', 'totp'],
    },
    {
      issuer,
      audience: options.audience ?? clientId,
      subject: userId,
      expiresInSeconds: 300,
    },
  );
  return 'Bearer ' + token;
}

async function signGlobalAdminToken(): Promise<string> {
  const token = await keys.signAccessToken(
    { scope: 'openid idp.admin', client_id: adminClientId, auth_time: nowSeconds(), acr: 'urn:on4net:acr:mfa', amr: ['pwd', 'totp'] },
    {
      issuer,
      audience: adminClientId,
      subject: state.adminUserId,
      expiresInSeconds: 300,
    },
  );
  return 'Bearer ' + token;
}

async function requestAuthorization(params: {
  sessionId: string;
  clientId: AppClientId;
  scope: string;
  loginContext?: string;
}): Promise<URL> {
  const response = await request(app.server)
    .get('/oauth2/authorize')
    .query({
      response_type: 'code',
      client_id: params.clientId,
      redirect_uri: REDIRECT_URI[params.clientId],
      scope: params.scope,
      state: 'state-1',
      nonce: 'nonce-1',
      code_challenge: s256Challenge(verifier),
      code_challenge_method: 'S256',
      ...(params.loginContext === undefined ? {} : { login_context: params.loginContext }),
    })
    .set('Cookie', `idpn_session=${params.sessionId}`)
    .expect(302);

  const location = response.headers.location;
  expect(location).toEqual(expect.any(String));
  return new URL(location as string);
}

/** Full `/oauth2/authorize` -> `/oauth2/token` flow for a public (PKCE) app client. */
async function issueTokens(
  userId: string,
  sessionId: string,
  clientId: AppClientId,
  scope = 'openid',
): Promise<IssuedTokens> {
  const location = await requestAuthorization({ sessionId, clientId, scope });
  expect(location.searchParams.get('error')).toBeNull();
  const code = location.searchParams.get('code');
  expect(code).toEqual(expect.any(String));

  const response = await request(app.server)
    .post('/oauth2/token')
    .send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI[clientId],
      client_id: clientId,
      code_verifier: verifier,
    })
    .expect(200);

  const body = response.body as IssuedTokens;
  const claims = await verifyAccess(body.access_token, clientId);
  expect(claims.sub).toBe(userId);
  return body;
}

async function refreshTokens(
  refreshToken: string,
  clientId: AppClientId,
): Promise<request.Response> {
  return request(app.server).post('/oauth2/token').send({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

async function snapshotApp(clientId: AppClientId): Promise<AppSnapshot> {
  const client = await prisma.client.findUniqueOrThrow({ where: { clientId } });
  const [permissions, roles, memberships, assignments, refreshTokens, users] = await Promise.all([
    prisma.permission.findMany({ where: { clientId: client.id }, select: { key: true } }),
    prisma.role.findMany({
      where: { clientId: client.id },
      select: {
        key: true,
        rolePermissions: { select: { permission: { select: { key: true } } } },
      },
    }),
    prisma.clientMembership.findMany({
      where: { clientId: client.id },
      select: { userId: true, status: true, loginContextId: true },
    }),
    prisma.assignment.findMany({
      where: { role: { clientId: client.id } },
      select: { roleId: true, subjectId: true, expiresAt: true },
    }),
    prisma.refreshToken.findMany({ where: { clientId: client.id }, select: { revokedAt: true } }),
    prisma.user.count(),
  ]);

  return {
    permissions: permissions.map((row) => row.key).sort(),
    roles: roles
      .map((row) => ({
        key: row.key,
        permissions: row.rolePermissions.map((entry) => entry.permission.key).sort(),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    memberships: memberships
      .map((row) => ({ userId: row.userId, status: row.status, contextId: row.loginContextId }))
      .sort((left, right) =>
        `${left.userId}:${left.contextId ?? ''}`.localeCompare(
          `${right.userId}:${right.contextId ?? ''}`,
        ),
      ),
    assignments: assignments
      .map((row) => ({
        roleId: row.roleId,
        subjectId: row.subjectId,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      }))
      .sort((left, right) =>
        `${left.roleId}:${left.subjectId}`.localeCompare(`${right.roleId}:${right.subjectId}`),
      ),
    refreshTokens: {
      active: refreshTokens.filter((row) => row.revokedAt === null).length,
      revoked: refreshTokens.filter((row) => row.revokedAt !== null).length,
    },
    users,
  };
}

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_cross_client_${Date.now()}`;
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

  const permissionReader = createPrismaPermissionReader(prisma);
  const rbacRepository = createPrismaRbacRepository(prisma);
  const clientsRepository = createPrismaClientRepository(prisma);
  usersRepository = createPrismaUserRepository(prisma);
  effectiveAccess = createPrismaEffectiveAccessSource(prisma);

  const isClientAdminEligible = async (userId: string, clientId: string): Promise<boolean> =>
    ((await permissionReader.clientPermissionsForUser?.(userId, clientId)) ?? []).length > 0;

  app = buildServer({
    issuer,
    keys,
    token: {
      clients: clientsRepository,
      codes: createPrismaCodeRepository(prisma),
      refreshTokens: createPrismaRefreshTokenRepository(prisma),
      users: usersRepository,
      sessions: {
        async read(sid: string) {
          return sessionMap.get(sid) ?? null;
        },
      },
      isClientAdminEligible,
      access: effectiveAccess,
      contextAccess: createPrismaLoginContextAccessSource(prisma),
    },
    authorize: {
      clients: clientsRepository,
      isClientAdminEligible,
      membershipStatus: createAuthorizeMembershipStatus(prisma),
    },
    userInfo: { users: usersRepository, access: effectiveAccess },
    rbac: {
      adminClientId,
      permissions: permissionReader,
      rbac: rbacRepository,
      audit: createPrismaAdminAudit(prisma),
    },
    adminMembers: {
      adminClientId,
      permissions: permissionReader,
      members: createPrismaMemberRepository(prisma, { rbac: rbacRepository }),
      audit: createPrismaAdminAudit(prisma),
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });

  const createClient = (clientId: string, scopes: string[], redirectUris: string[] = []) =>
    prisma.client.create({
      data: {
        clientId,
        name: clientId,
        type: 'spa',
        redirectUris,
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes,
        tenantId: tenant.id,
      },
    });

  await createClient(adminClientId, ['openid', 'idp.admin']);
  const appARow = await createClient(
    'app-a',
    ['openid', 'idp.client-admin', 'offline_access'],
    [REDIRECT_URI['app-a']],
  );
  const appBRow = await createClient(
    'app-b',
    ['openid', 'idp.client-admin', 'offline_access'],
    [REDIRECT_URI['app-b']],
  );

  const createUser = (username: string, status: 'active' | 'pending' = 'active') =>
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        username,
        email: `${username}@example.com`,
        displayName: username,
        status,
      },
    });

  const admin = await createUser('admin');
  const delegatedA = await createUser('delegated-a');
  const delegatedB = await createUser('delegated-b');
  const member = await createUser('member');
  const memberBOnly = await createUser('member-b-only');
  const bulkUser = await createUser('bulk-user');
  const scopeUser = await createUser('scope-user');
  const targetA = await createUser('target-a', 'pending');
  const targetB = await createUser('target-b', 'pending');
  const globalTarget = await createUser('global-target', 'pending');

  const createPermission = (key: string, clientId: string | null) =>
    prisma.permission.create({ data: { key, description: key, clientId } });

  const globalPermissions = new Map<string, { id: string }>();
  for (const key of GLOBAL_PERMISSIONS) {
    globalPermissions.set(key, await createPermission(key, null));
  }
  const appAContactRead = await createPermission('app-a:contact:read', appARow.id);
  const appAContactWrite = await createPermission('app-a:contact:write', appARow.id);
  const appAReportExport = await createPermission('app-a:report:export', appARow.id);
  const appBSecretRead = await createPermission('app-b:secret:read', appBRow.id);

  const bulkPermissionKeys = Array.from(
    { length: BULK_PERMISSION_COUNT },
    (_value, index) =>
      `app-a:bulk:report:section-${index.toString().padStart(3, '0')}:export-detail`,
  );
  const bulkPermissions: { id: string }[] = [];
  for (const key of bulkPermissionKeys) {
    bulkPermissions.push(await createPermission(key, appARow.id));
  }

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
    });

  const globalPermissionList = (keysToInclude: string[]) =>
    keysToInclude.map((key) => globalPermissions.get(key)!);

  const catalogAdmin = await createRole(
    'catalog-admin',
    null,
    globalPermissionList([
      'idp:role:read',
      'idp:role:write',
      'idp:client-role:read',
      'idp:client-role:write',
      'idp:client-role:assign',
      'idp:client-member:read',
      'idp:client-member:invite',
      'idp:client-member:write',
      'idp:client-session:read',
    ]),
  );
  const appAUserAdmin = await createRole(
    'app-a:user-admin',
    appARow.id,
    globalPermissionList([
      'idp:client-role:read',
      'idp:client-role:write',
      'idp:client-role:assign',
      'idp:client-member:read',
      'idp:client-member:invite',
      'idp:client-member:write',
      'idp:client-session:read',
    ]),
  );
  const appBUserAdmin = await createRole(
    'app-b:user-admin',
    appBRow.id,
    globalPermissionList([
      'idp:client-role:read',
      'idp:client-role:write',
      'idp:client-role:assign',
      'idp:client-member:read',
      'idp:client-member:invite',
      'idp:client-member:write',
      'idp:client-session:read',
    ]),
  );
  const appAMember = await createRole('app-a:member', appARow.id, [appAContactRead], true);
  const appAEditor = await createRole('app-a:editor', appARow.id, [appAContactWrite]);
  const appAExpired = await createRole('app-a:expired', appARow.id, [appAReportExport]);
  const appABulk = await createRole('app-a:bulk', appARow.id, bulkPermissions);
  const appBMember = await createRole('app-b:member', appBRow.id, [appBSecretRead], true);
  // A global role that must never contribute `idp:*` roles or another client's permissions
  // to an app token, even when it is assigned to the user.
  const globalLeak = await createRole('idp:global-leak', null, [
    globalPermissions.get('idp:user:read')!,
    appBSecretRead,
  ]);

  const customerContext = await prisma.clientLoginContext.create({
    data: {
      clientId: appARow.id,
      key: 'customer-admin',
      name: 'Customer admin',
      allowedRoles: ['app-a:editor'],
      defaultRoles: [],
      loginMethods: ['password'],
      sessionIdleTtl: 1800,
      sessionAbsoluteTtl: 28_800,
      isDefault: true,
    },
  });

  const createMembership = (
    clientUuid: string,
    userId: string,
    options: {
      loginContextId?: string | null;
      status?: 'invited' | 'active';
      attributes?: Record<string, unknown>;
    } = {},
  ) =>
    prisma.clientMembership.create({
      data: {
        clientId: clientUuid,
        userId,
        loginContextId: options.loginContextId ?? null,
        status: options.status ?? 'active',
        attributes: (options.attributes ?? {}) as never,
        invitedBy: admin.id,
        ...(options.status === 'invited' ? { invitedAt: new Date() } : { joinedAt: new Date() }),
      },
    });

  await createMembership(appARow.id, member.id, { attributes: { department: 'sales' } });
  await createMembership(appARow.id, member.id, {
    loginContextId: customerContext.id,
    attributes: { department: 'sales' },
  });
  await createMembership(appBRow.id, member.id);
  await createMembership(appBRow.id, memberBOnly.id);
  await createMembership(appARow.id, targetA.id, { status: 'invited' });
  await createMembership(appBRow.id, targetB.id, { status: 'invited' });
  await createMembership(appBRow.id, globalTarget.id, { status: 'invited' });
  // An unbound request (no `login_context`) is the client-wide membership; app-a defines a
  // login context, so these users need that row to receive an app-a token.
  await createMembership(appARow.id, bulkUser.id);
  await createMembership(appARow.id, scopeUser.id);

  const assign = (userId: string, roleId: string, expiresAt: Date | null = null) =>
    prisma.assignment.create({
      data: {
        subjectType: 'user',
        subjectId: userId,
        roleId,
        scopeType: 'global',
        assignedBy: admin.id,
        expiresAt,
      },
    });

  await assign(admin.id, catalogAdmin.id);
  await assign(delegatedA.id, appAUserAdmin.id);
  await assign(delegatedB.id, appBUserAdmin.id);
  await assign(member.id, appAMember.id);
  await assign(member.id, appAEditor.id);
  await assign(member.id, appAExpired.id, new Date(Date.now() - 86_400_000));
  await assign(member.id, appBMember.id);
  await assign(member.id, globalLeak.id);
  await assign(memberBOnly.id, appBMember.id);
  await assign(bulkUser.id, appABulk.id);
  const scopeUserAssignment = await assign(scopeUser.id, appAUserAdmin.id);

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
    adminUserId: admin.id,
    delegated: { 'app-a': delegatedA.id, 'app-b': delegatedB.id },
    memberUserId: member.id,
    memberBOnlyId: memberBOnly.id,
    bulkUserId: bulkUser.id,
    scopeUserId: scopeUser.id,
    scopeUserAssignmentId: scopeUserAssignment.id,
    globalTargetId: globalTarget.id,
    targets: { 'app-a': targetA.id, 'app-b': targetB.id },
    permissionIds: { 'app-a': appAContactRead.id, 'app-b': appBSecretRead.id },
    apps: {
      'app-a': {
        internalId: appARow.id,
        memberRoleId: appAMember.id,
        userAdminRoleId: appAUserAdmin.id,
      },
      'app-b': {
        internalId: appBRow.id,
        memberRoleId: appBMember.id,
        userAdminRoleId: appBUserAdmin.id,
      },
    },
    sessions: {
      member: await createSession(member.id),
      bulk: await createSession(bulkUser.id),
      scope: await createSession(scopeUser.id),
    },
    bulkPermissionKeys,
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

describe('deny by default', () => {
  it('rejects an anonymous request with 401', async () => {
    const catalog = await request(app.server).get('/api/v1/permissions').expect(401);
    expect(catalog.body.type).toContain('/unauthorized');

    const members = await request(app.server).get('/api/v1/clients/app-a/members').expect(401);
    expect(members.body.type).toContain('/unauthorized');
  });

  it('rejects a valid app token without any admin permission with 403', async () => {
    const authorization = await signDelegatedToken('app-a', state.memberUserId);
    const before = await snapshotApp('app-a');

    const roles = await request(app.server)
      .get('/api/v1/roles')
      .set('Authorization', authorization)
      .expect(403);
    expect(roles.body.type).toContain('/forbidden');

    const members = await request(app.server)
      .get('/api/v1/clients/app-a/members')
      .set('Authorization', authorization)
      .expect(403);
    expect(members.body.type).toContain('/forbidden');

    await expect(snapshotApp('app-a')).resolves.toEqual(before);
  });

  it('does not write anything when a denied caller tries to create a permission', async () => {
    const authorization = await signDelegatedToken('app-a', state.memberUserId);
    const before = await snapshotApp('app-a');

    await request(app.server)
      .post('/api/v1/permissions')
      .set('Authorization', authorization)
      .send({ key: 'app-a:denied:write', clientId: 'app-a', description: 'denied' })
      .expect(403);

    await expect(
      prisma.permission.findUnique({ where: { key: 'app-a:denied:write' } }),
    ).resolves.toBeNull();
    await expect(snapshotApp('app-a')).resolves.toEqual(before);
  });

  it('rejects unknown permission keys when creating a role with 422', async () => {
    const authorization = await signGlobalAdminToken();
    const before = await snapshotApp('app-a');

    const response = await request(app.server)
      .post('/api/v1/roles')
      .set('Authorization', authorization)
      .send({
        key: 'app-a:ghost',
        name: 'Ghost',
        clientId: 'app-a',
        permissions: ['app-a:missing:read'],
      })
      .expect(422);
    expect(response.body.detail).toContain('unknown permission');

    await expect(prisma.role.findUnique({ where: { key: 'app-a:ghost' } })).resolves.toBeNull();
    await expect(snapshotApp('app-a')).resolves.toEqual(before);
  });

  it('rejects unknown role keys when inviting a member with 422 and creates no user', async () => {
    const authorization = await signGlobalAdminToken();

    const response = await request(app.server)
      .post('/api/v1/clients/app-a/members/invite')
      .set('Authorization', authorization)
      .send({ email: 'ghost-role@example.com', roleKeys: ['app-a:ghost'] })
      .expect(422);
    expect(response.body.detail).toContain('unknown role');

    await expect(
      prisma.user.findFirst({ where: { email: 'ghost-role@example.com' } }),
    ).resolves.toBeNull();
  });

  it('rejects unknown role keys when replacing member roles with 422', async () => {
    const authorization = await signGlobalAdminToken();
    const before = await snapshotApp('app-a');

    const response = await request(app.server)
      .put(`/api/v1/clients/app-a/members/${state.memberUserId}/roles`)
      .set('Authorization', authorization)
      .send({ roleKeys: ['app-a:ghost'] })
      .expect(422);
    expect(response.body.detail).toContain('unknown role');

    await expect(snapshotApp('app-a')).resolves.toEqual(before);
  });

  it('rejects unknown permission keys when replacing role permissions with 422', async () => {
    const authorization = await signGlobalAdminToken();
    const before = await snapshotApp('app-a');

    const response = await request(app.server)
      .put(`/api/v1/roles/${state.apps['app-a'].memberRoleId}/permissions`)
      .set('Authorization', authorization)
      .send({ permissions: ['app-a:missing:read'] })
      .expect(422);
    expect(response.body.detail).toContain('unknown permission');

    await expect(snapshotApp('app-a')).resolves.toEqual(before);
  });

  it('returns 404 for a membership that exists only for another client', async () => {
    const authorization = await signGlobalAdminToken();

    await request(app.server)
      .get(`/api/v1/clients/app-a/members/${state.memberBOnlyId}`)
      .set('Authorization', authorization)
      .expect(404);

    const own = await request(app.server)
      .get(`/api/v1/clients/app-b/members/${state.memberBOnlyId}`)
      .set('Authorization', authorization)
      .expect(200);
    expect(own.body.userId).toBe(state.memberBOnlyId);
  });
});

describe('access token claims', () => {
  it('contains only app-a roles, permissions and membership', async () => {
    const tokens = await issueTokens(state.memberUserId, state.sessions.member, 'app-a');
    const claims = await verifyAccess(tokens.access_token, 'app-a');

    expect(claims.roles).toEqual(['app-a:editor', 'app-a:member']);
    expect(claims.permissions).toEqual(['app-a:contact:read', 'app-a:contact:write']);
    expect(claims.membership).toEqual({
      context: null,
      status: 'active',
      attributes: { department: 'sales' },
    });
    expect(claims.login_context).toBeUndefined();
    expect(tokens.scope).toBe('openid');
  });

  it('never carries another client data or idp:* data', async () => {
    const tokens = await issueTokens(state.memberUserId, state.sessions.member, 'app-a');
    const claims = await verifyAccess(tokens.access_token, 'app-a');

    const roles = claims.roles as string[];
    const permissions = claims.permissions as string[];

    expect(roles.some((key) => key.startsWith('idp:'))).toBe(false);
    expect(permissions.some((key) => key.startsWith('idp:'))).toBe(false);
    expect(roles).not.toContain('app-b:member');
    expect(permissions).not.toContain('app-b:secret:read');
    expect(permissions).not.toContain('idp:user:read');
    // The global role `idp:global-leak` is assigned but must stay invisible.
    expect(roles).not.toContain('idp:global-leak');
  });

  it('ignores expired assignments', async () => {
    const tokens = await issueTokens(state.memberUserId, state.sessions.member, 'app-a');
    const claims = await verifyAccess(tokens.access_token, 'app-a');

    expect(claims.roles).not.toContain('app-a:expired');
    expect(claims.permissions).not.toContain('app-a:report:export');
  });

  it('issues an app-b token with only app-b data', async () => {
    const tokens = await issueTokens(state.memberUserId, state.sessions.member, 'app-b');
    const claims = await verifyAccess(tokens.access_token, 'app-b');

    expect(claims.client_id).toBe('app-b');
    expect(claims.roles).toEqual(['app-b:member']);
    expect(claims.permissions).toEqual(['app-b:secret:read']);
    expect(claims.membership).toEqual({ context: null, status: 'active', attributes: {} });
    expect(claims.roles).not.toContain('app-a:member');
    expect(claims.permissions).not.toContain('app-a:contact:read');
    expect((claims.roles as string[]).some((key) => key.startsWith('idp:'))).toBe(false);
    expect(claims.roles).not.toContain('idp:global-leak');
    expect(claims.permissions).not.toContain('idp:user:read');
  });

  it('falls back to permissions_source=userinfo when the claim set is too large', async () => {
    const tokens = await issueTokens(state.bulkUserId, state.sessions.bulk, 'app-a');
    const claims = await verifyAccess(tokens.access_token, 'app-a');

    expect(claims.permissions_source).toBe('userinfo');
    expect(claims.roles).toBeUndefined();
    expect(claims.permissions).toBeUndefined();

    const userinfo = await request(app.server)
      .get('/oauth2/userinfo')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .expect(200);

    expect(userinfo.body.roles).toEqual(['app-a:bulk']);
    expect(userinfo.body.permissions).toEqual([...state.bulkPermissionKeys].sort());
  });

  it('narrows roles and permissions to the requested login context', async () => {
    // The end-to-end context binding (code -> token -> refresh) is covered by the
    // "binds the login context ..." test below; this asserts the resolution and claim
    // assembly used by the token route once the context is known.
    const access = await effectiveAccess.resolve({
      userId: state.memberUserId,
      clientId: 'app-a',
      loginContext: 'customer-admin',
    });
    expect(access.roles).toEqual(['app-a:editor']);
    expect(access.permissions).toEqual(['app-a:contact:write']);
    expect(access.membership?.context).toBe('customer-admin');

    const profile = await usersRepository.findProfile(state.memberUserId);
    expect(profile).not.toBeNull();

    const code: AuthorizationCodeRecord = {
      codeHash: 'claim-test',
      clientId: 'app-a',
      userId: state.memberUserId,
      sessionId: state.sessions.member,
      redirectUri: REDIRECT_URI['app-a'],
      scope: ['openid'],
      nonce: 'nonce-1',
      codeChallenge: s256Challenge(verifier),
      codeChallengeMethod: 'S256',
      authTime: new Date(),
      acr: 'urn:on4net:acr:pwd',
      amr: ['pwd'],
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      loginContext: 'customer-admin',
    };

    const claims = buildAccessTokenClaims({
      issuer,
      clientId: 'app-a',
      profile: profile!,
      code,
      expiresInSeconds: 600,
      issuedAt: nowSeconds(),
      jti: 'jti-claim-test',
      access,
    });

    expect(claims.login_context).toBe('customer-admin');
    expect(claims.roles).toEqual(['app-a:editor']);
    expect(claims.permissions).toEqual(['app-a:contact:write']);
  });

  it('binds the login context to the code, token claims and refresh rotation', async () => {
    const location = await requestAuthorization({
      sessionId: state.sessions.member,
      clientId: 'app-a',
      scope: 'openid offline_access',
      loginContext: 'customer-admin',
    });
    expect(location.searchParams.get('error')).toBeNull();
    const code = location.searchParams.get('code');
    expect(code).toEqual(expect.any(String));

    const response = await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI['app-a'],
        client_id: 'app-a',
        code_verifier: verifier,
      })
      .expect(200);

    const claims = await verifyAccess(response.body.access_token, 'app-a');
    expect(claims.login_context).toBe('customer-admin');
    expect(claims.roles).toEqual(['app-a:editor']);
    expect(claims.permissions).toEqual(['app-a:contact:write']);
    expect(claims.membership).toEqual({
      context: 'customer-admin',
      status: 'active',
      attributes: { department: 'sales' },
    });

    // A rotated refresh token must stay bound to the same context: no privilege widening.
    const refreshed = await refreshTokens(response.body.refresh_token, 'app-a');
    expect(refreshed.status).toBe(200);
    const refreshedClaims = await verifyAccess(refreshed.body.access_token, 'app-a');
    expect(refreshedClaims.login_context).toBe('customer-admin');
    expect(refreshedClaims.roles).toEqual(['app-a:editor']);
    expect(refreshedClaims.permissions).toEqual(['app-a:contact:write']);
  });
});

interface CrossClientAttack {
  name: string;
  invoke: (authorization: string) => request.Test;
}

function crossClientAttacks(attacker: AppClientId, victim: AppClientId): CrossClientAttack[] {
  const victimRoleId = (): string => state.apps[victim].memberRoleId;
  const victimPermissionId = (): string => state.permissionIds[victim];
  const victimTarget = (): string => state.targets[victim];

  return [
    {
      name: 'listing the permissions of another client',
      invoke: (authorization) =>
        request(app.server)
          .get('/api/v1/permissions')
          .query({ clientId: victim })
          .set('Authorization', authorization),
    },
    {
      name: 'listing the roles of another client',
      invoke: (authorization) =>
        request(app.server)
          .get('/api/v1/roles')
          .query({ clientId: victim })
          .set('Authorization', authorization),
    },
    {
      name: 'reading a role of another client',
      invoke: (authorization) =>
        request(app.server)
          .get(`/api/v1/roles/${victimRoleId()}`)
          .set('Authorization', authorization),
    },
    {
      name: 'creating a permission for another client',
      invoke: (authorization) =>
        request(app.server)
          .post('/api/v1/permissions')
          .set('Authorization', authorization)
          .send({
            key: `${victim}:attack-${attacker}:read`,
            clientId: victim,
            description: 'cross-client',
          }),
    },
    {
      name: 'creating a role for another client',
      invoke: (authorization) =>
        request(app.server)
          .post('/api/v1/roles')
          .set('Authorization', authorization)
          .send({ key: `${victim}:attack-${attacker}`, name: 'Attack', clientId: victim }),
    },
    {
      name: 'deleting a role of another client',
      invoke: (authorization) =>
        request(app.server)
          .delete(`/api/v1/roles/${victimRoleId()}`)
          .set('Authorization', authorization),
    },
    {
      name: 'deleting a permission of another client',
      invoke: (authorization) =>
        request(app.server)
          .delete(`/api/v1/permissions/${victimPermissionId()}`)
          .set('Authorization', authorization),
    },
    {
      name: 'listing the members of another client',
      invoke: (authorization) =>
        request(app.server)
          .get(`/api/v1/clients/${victim}/members`)
          .set('Authorization', authorization),
    },
    {
      name: 'reading a member of another client',
      invoke: (authorization) =>
        request(app.server)
          .get(`/api/v1/clients/${victim}/members/${victimTarget()}`)
          .set('Authorization', authorization),
    },
    {
      name: 'inviting a member to another client',
      invoke: (authorization) =>
        request(app.server)
          .post(`/api/v1/clients/${victim}/members/invite`)
          .set('Authorization', authorization)
          .send({ email: `attack-${attacker}-to-${victim}@example.com`, attributes: {} }),
    },
    {
      name: 'patching a member of another client',
      invoke: (authorization) =>
        request(app.server)
          .patch(`/api/v1/clients/${victim}/members/${victimTarget()}`)
          .set('Authorization', authorization)
          .send({ status: 'suspended' }),
    },
    {
      name: 'deleting a member of another client',
      invoke: (authorization) =>
        request(app.server)
          .delete(`/api/v1/clients/${victim}/members/${victimTarget()}`)
          .set('Authorization', authorization),
    },
    {
      name: 'replacing the roles of a member of another client',
      invoke: (authorization) =>
        request(app.server)
          .put(`/api/v1/clients/${victim}/members/${victimTarget()}/roles`)
          .set('Authorization', authorization)
          .send({ roleKeys: [] }),
    },
    {
      name: 'listing the sessions of a member of another client',
      invoke: (authorization) =>
        request(app.server)
          .get(`/api/v1/clients/${victim}/members/${victimTarget()}/sessions`)
          .set('Authorization', authorization),
    },
  ];
}

const DIRECTIONS: { attacker: AppClientId; victim: AppClientId }[] = [
  { attacker: 'app-a', victim: 'app-b' },
  { attacker: 'app-b', victim: 'app-a' },
];

for (const direction of DIRECTIONS) {
  describe(`delegated admin of ${direction.attacker} against ${direction.victim}`, () => {
    const authorization = (): Promise<string> =>
      signDelegatedToken(direction.attacker, state.delegated[direction.attacker]);

    for (const attack of crossClientAttacks(direction.attacker, direction.victim)) {
      it(`rejects ${attack.name} with 403 and writes nothing in ${direction.victim}`, async () => {
        const before = await snapshotApp(direction.victim);
        const response = await attack.invoke(await authorization());

        expect(response.status).toBe(403);
        expect(String(response.body.type)).toContain('/forbidden');
        await expect(snapshotApp(direction.victim)).resolves.toEqual(before);
      });
    }

    it('cannot attach a global permission to one of its own roles', async () => {
      const header = await authorization();
      const before = await snapshotApp(direction.attacker);

      const response = await request(app.server)
        .post('/api/v1/roles')
        .set('Authorization', header)
        .send({
          key: `${direction.attacker}:privileged`,
          name: 'Privileged',
          clientId: direction.attacker,
          permissions: ['idp:user:read'],
        })
        .expect(422);
      expect(response.body.detail).toContain('does not belong');

      await expect(snapshotApp(direction.attacker)).resolves.toEqual(before);
    });

    it('manages its own permission catalog and roles', async () => {
      const header = await authorization();
      const ownPermission =
        direction.attacker === 'app-a' ? 'app-a:contact:read' : 'app-b:secret:read';
      const foreignPermission =
        direction.attacker === 'app-a' ? 'app-b:secret:read' : 'app-a:contact:read';

      const permissions = await request(app.server)
        .get('/api/v1/permissions')
        .query({ limit: 100 })
        .set('Authorization', header)
        .expect(200);
      const permissionKeys = (permissions.body.items as { key: string }[]).map((item) => item.key);
      expect(permissionKeys).toContain(ownPermission);
      expect(permissionKeys).not.toContain(foreignPermission);

      const roles = await request(app.server)
        .get('/api/v1/roles')
        .set('Authorization', header)
        .expect(200);
      const roleKeys = (roles.body.items as { key: string }[]).map((item) => item.key);
      expect(roleKeys).toContain(`${direction.attacker}:member`);
      expect(roleKeys).not.toContain(`${direction.victim}:member`);

      await request(app.server)
        .post('/api/v1/permissions')
        .set('Authorization', header)
        .send({
          key: `${direction.attacker}:invoice:read`,
          clientId: direction.attacker,
          description: 'invoices',
        })
        .expect(201);

      const created = await request(app.server)
        .post('/api/v1/roles')
        .set('Authorization', header)
        .send({
          key: `${direction.attacker}:billing`,
          name: 'Billing',
          clientId: direction.attacker,
          permissions: [`${direction.attacker}:invoice:read`],
        })
        .expect(201);
      expect(created.body.clientId).toBe(direction.attacker);

      await request(app.server)
        .get(`/api/v1/roles/${created.body.id as string}`)
        .set('Authorization', header)
        .expect(200);

      await request(app.server)
        .delete(`/api/v1/roles/${created.body.id as string}`)
        .set('Authorization', header)
        .expect(204);
    });

    it('manages only its own members', async () => {
      const header = await authorization();

      const list = await request(app.server)
        .get(`/api/v1/clients/${direction.attacker}/members`)
        .set('Authorization', header)
        .expect(200);
      const userIds = (list.body.items as { userId: string }[]).map((item) => item.userId);
      expect(userIds).toContain(state.targets[direction.attacker]);
      expect(userIds).not.toContain(state.targets[direction.victim]);

      const invited = await request(app.server)
        .post(`/api/v1/clients/${direction.attacker}/members/invite`)
        .set('Authorization', header)
        .send({ email: `own-invite-${direction.attacker}@example.com` })
        .expect(201);
      const invitedUserId = invited.body.member.userId as string;

      const activated = await request(app.server)
        .patch(`/api/v1/clients/${direction.attacker}/members/${invitedUserId}`)
        .set('Authorization', header)
        .send({ status: 'active' })
        .expect(200);
      expect(activated.body.status).toBe('active');

      const roles = await request(app.server)
        .put(`/api/v1/clients/${direction.attacker}/members/${invitedUserId}/roles`)
        .set('Authorization', header)
        .send({ roleKeys: [`${direction.attacker}:member`] })
        .expect(200);
      expect(roles.body.roleKeys).toEqual([`${direction.attacker}:member`]);

      await request(app.server)
        .delete(`/api/v1/clients/${direction.attacker}/members/${invitedUserId}`)
        .set('Authorization', header)
        .expect(204);
    });
  });
}

describe('global admin across clients', () => {
  it('reads roles and members of any client', async () => {
    const header = await signGlobalAdminToken();

    const appBRoles = await request(app.server)
      .get('/api/v1/roles')
      .query({ clientId: 'app-b' })
      .set('Authorization', header)
      .expect(200);
    expect((appBRoles.body.items as { key: string }[]).map((item) => item.key)).toContain(
      'app-b:member',
    );

    await request(app.server)
      .get(`/api/v1/roles/${state.apps['app-b'].memberRoleId}`)
      .set('Authorization', header)
      .expect(200);

    const appAMembers = await request(app.server)
      .get('/api/v1/clients/app-a/members')
      .set('Authorization', header)
      .expect(200);
    expect((appAMembers.body.items as { userId: string }[]).map((item) => item.userId)).toContain(
      state.memberUserId,
    );

    const appBMembers = await request(app.server)
      .get('/api/v1/clients/app-b/members')
      .set('Authorization', header)
      .expect(200);
    expect((appBMembers.body.items as { userId: string }[]).map((item) => item.userId)).toContain(
      state.memberBOnlyId,
    );
  });

  it('creates and deletes a role for a client', async () => {
    const created = await request(app.server)
      .post('/api/v1/roles')
      .set('Authorization', await signGlobalAdminToken())
      .send({ key: 'app-b:global-created', name: 'Global created', clientId: 'app-b' })
      .expect(201);

    await request(app.server)
      .delete(`/api/v1/roles/${created.body.id as string}`)
      .set('Authorization', await signGlobalAdminToken())
      .expect(204);
  });

  it('updates a membership of a client', async () => {
    const response = await request(app.server)
      .patch(`/api/v1/clients/app-b/members/${state.globalTargetId}`)
      .set('Authorization', await signGlobalAdminToken())
      .send({ status: 'active' })
      .expect(200);

    expect(response.body.status).toBe('active');
  });
});

describe('idp.client-admin scope', () => {
  it('refuses the scope for a user without idp:client-* permissions', async () => {
    const location = await requestAuthorization({
      sessionId: state.sessions.member,
      clientId: 'app-a',
      scope: 'openid idp.client-admin',
    });

    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('code')).toBeNull();
    expect(location.searchParams.get('state')).toBe('state-1');
  });

  it('refuses the scope for a client the user does not administer', async () => {
    const location = await requestAuthorization({
      sessionId: state.sessions.member,
      clientId: 'app-b',
      scope: 'openid idp.client-admin',
    });
    expect(location.searchParams.get('error')).toBe('access_denied');

    const delegated = await requestAuthorization({
      sessionId: state.sessions.scope,
      clientId: 'app-b',
      scope: 'openid idp.client-admin',
    });
    expect(delegated.searchParams.get('error')).toBe('access_denied');
  });

  it('issues a code for a user holding idp:client-* permissions for that client', async () => {
    const location = await requestAuthorization({
      sessionId: state.sessions.scope,
      clientId: 'app-a',
      scope: 'openid idp.client-admin',
    });

    expect(location.searchParams.get('error')).toBeNull();
    expect(location.searchParams.get('code')).toEqual(expect.any(String));
  });

  it('refuses the code exchange when the permission was revoked after authorization', async () => {
    const location = await requestAuthorization({
      sessionId: state.sessions.scope,
      clientId: 'app-a',
      scope: 'openid idp.client-admin',
    });
    const code = location.searchParams.get('code') ?? '';
    expect(code).not.toBe('');

    await prisma.assignment.delete({ where: { id: state.scopeUserAssignmentId } });

    const response = await request(app.server)
      .post('/oauth2/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI['app-a'],
        client_id: 'app-a',
        code_verifier: verifier,
      })
      .expect(400);

    expect(response.body.error).toBe('access_denied');
  });

  it('rejects a token whose audience does not match its client', async () => {
    const token = await keys.signAccessToken(
      { scope: 'openid idp.client-admin', client_id: 'app-a', auth_time: nowSeconds() },
      {
        issuer,
        audience: 'app-b',
        subject: state.delegated['app-a'],
        expiresInSeconds: 300,
      },
    );

    const response = await request(app.server)
      .get('/api/v1/clients/app-a/members')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(response.body.type).toContain('/unauthorized');
  });
});

describe('membership suspension', () => {
  it('revokes only that client refresh tokens and drops that client claims', async () => {
    const appATokens = await issueTokens(
      state.memberUserId,
      state.sessions.member,
      'app-a',
      'openid offline_access',
    );
    const appBTokens = await issueTokens(
      state.memberUserId,
      state.sessions.member,
      'app-b',
      'openid offline_access',
    );
    expect(appATokens.refresh_token).toEqual(expect.any(String));
    expect(appBTokens.refresh_token).toEqual(expect.any(String));

    await request(app.server)
      .patch(`/api/v1/clients/app-a/members/${state.memberUserId}`)
      .set('Authorization', await signGlobalAdminToken())
      .send({ status: 'suspended' })
      .expect(200);

    const appARow = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(appATokens.refresh_token!) },
    });
    const appBRow = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(appBTokens.refresh_token!) },
    });
    expect(appARow.revokedAt).not.toBeNull();
    expect(appBRow.revokedAt).toBeNull();

    const refused = await refreshTokens(appATokens.refresh_token!, 'app-a');
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_grant');

    const refreshed = await refreshTokens(appBTokens.refresh_token!, 'app-b');
    expect(refreshed.status).toBe(200);
    const appBClaims = await verifyAccess(refreshed.body.access_token as string, 'app-b');
    expect(appBClaims.roles).toEqual(['app-b:member']);
    expect(appBClaims.permissions).toEqual(['app-b:secret:read']);

    const appAAccess = await effectiveAccess.resolve({
      userId: state.memberUserId,
      clientId: 'app-a',
    });
    expect(appAAccess.roles).toEqual([]);
    expect(appAAccess.permissions).toEqual([]);
    expect(appAAccess.membership?.status).toBe('suspended');

    const appBAccess = await effectiveAccess.resolve({
      userId: state.memberUserId,
      clientId: 'app-b',
    });
    expect(appBAccess.roles).toEqual(['app-b:member']);
    expect(appBAccess.permissions).toEqual(['app-b:secret:read']);
    expect(appBAccess.membership?.status).toBe('active');

    // A suspended membership is denied at authorize (docs/login-contexts.md 4.1): no code
    // is issued, so a suspended user cannot obtain an unnarrowed/empty token either.
    const reopened = await requestAuthorization({
      sessionId: state.sessions.member,
      clientId: 'app-a',
      scope: 'openid',
    });
    expect(reopened.searchParams.get('error')).toBe('access_denied');
    expect(reopened.searchParams.get('code')).toBeNull();

    await request(app.server)
      .patch(`/api/v1/clients/app-a/members/${state.memberUserId}`)
      .set('Authorization', await signGlobalAdminToken())
      .send({ status: 'active' })
      .expect(200);
  });
});
