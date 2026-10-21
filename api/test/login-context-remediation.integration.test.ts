import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaLoginContextRepository } from '../src/admin/login-contexts/prisma-login-context-repository.js';
import { createPrismaMemberRepository } from '../src/admin/members/prisma-member-repository.js';
import { createPrismaAdminAudit } from '../src/admin/prisma-audit.js';
import { createPrismaPermissionReader } from '../src/admin/prisma-permission-reader.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPrismaEffectiveAccessSource } from '../src/oidc/effective-access.js';
import { MemorySigningKeyRepository, SigningKeyManager } from '../src/oidc/keys.js';
import { buildServer } from '../src/server.js';

/**
 * Remediation of the login-context review findings (issue #72).
 *
 * Each case closes one finding: a disabled context must be re-openable, a refused call must
 * leave an audit row, a role granted by two contexts must survive the removal of one
 * membership, a context invitation must be re-sendable, and `branding` must be rejected at
 * write time instead of being sanitized only on the way out.
 */

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'http://127.0.0.1:3400';
const adminClientId = 'admin-panel';
const nowSeconds = (): number => Math.floor(Date.now() / 1000);
/** Older than the 300 second step-up window. */
const staleAuthTime = (): number => nowSeconds() - 3600;

const ADMIN_PERMISSIONS = [
  'idp:client-context:read',
  'idp:client-context:write',
  'idp:client-member:read',
  'idp:client-member:invite',
  'idp:client-member:write',
  'idp:client-role:assign',
];

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';
let prisma: PrismaClient;
let keys: SigningKeyManager;
let app: ReturnType<typeof buildServer>;
let effectiveAccess: ReturnType<typeof createPrismaEffectiveAccessSource>;

interface Fixtures {
  appAId: string;
  appBId: string;
  adminUserId: string;
  appBAdminUserId: string;
}

let state: Fixtures;

/** Every delivered invitation is recorded so the resend path is provable. */
const sentInvites: string[] = [];
let mailFailure = false;

const connectionString = (): string => connectionStringValue;

const contextPath = (clientId: string) => `/api/v1/clients/${clientId}/login-contexts`;
const membersPath = (clientId: string, key: string) => `${contextPath(clientId)}/${key}/members`;

const contextBody = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  name: key,
  allowedRoles: ['app-a:member'],
  defaultRoles: [],
  loginMethods: ['password'],
  mfaPolicy: 'optional',
  registrationPolicy: 'invite_only',
  allowedEmailDomains: [],
  sessionIdleTtl: 900,
  sessionAbsoluteTtl: 28_800,
  stepUpRequired: false,
  isDefault: false,
  sortOrder: 0,
  ...overrides,
});

async function sign(
  userId: string,
  clientId: string,
  scope: string,
  authTime: number = nowSeconds(),
): Promise<string> {
  const accessToken = await keys.signAccessToken(
    { scope, client_id: clientId, auth_time: authTime },
    { issuer, audience: clientId, subject: userId, expiresInSeconds: 300 },
  );
  return 'Bearer ' + accessToken;
}

const globalAuth = (authTime?: number): Promise<string> =>
  sign(state.adminUserId, adminClientId, 'openid idp.admin', authTime);
const appBAdminAuth = (): Promise<string> =>
  sign(state.appBAdminUserId, 'app-b', 'openid idp.client-admin');

const api = () => request(app.server);

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_ctx_remediation_${Date.now()}`;
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
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString() }) });

  keys = new SigningKeyManager(new MemorySigningKeyRepository());
  await keys.ensureKey();

  const permissions = createPrismaPermissionReader(prisma);
  const audit = createPrismaAdminAudit(prisma);
  effectiveAccess = createPrismaEffectiveAccessSource(prisma);

  app = buildServer({
    issuer,
    keys,
    adminMembers: {
      adminClientId,
      permissions,
      members: createPrismaMemberRepository(prisma),
      audit,
      notifications: {
        async sendInvite(userId) {
          sentInvites.push(userId);
          if (mailFailure) {
            throw new Error('smtp unavailable');
          }
          return 'invitation';
        },
      },
    },
    adminLoginContexts: {
      adminClientId,
      permissions,
      contexts: createPrismaLoginContextRepository(prisma),
      audit,
    },
  });
  await app.ready();

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  const makeClient = (clientId: string, scopes: string[]) =>
    prisma.client.create({
      data: {
        clientId,
        name: clientId,
        type: 'web',
        redirectUris: [],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        scopes,
        tenantId: tenant.id,
      },
      select: { id: true },
    });
  await makeClient(adminClientId, ['openid', 'idp.admin']);
  const appA = await makeClient('app-a', ['openid', 'idp.client-admin']);
  const appB = await makeClient('app-b', ['openid', 'idp.client-admin']);

  const permissionIds: string[] = [];
  for (const key of ADMIN_PERMISSIONS) {
    const row = await prisma.permission.create({ data: { key, description: key } });
    permissionIds.push(row.id);
  }
  const adminRole = await prisma.role.create({
    data: {
      key: 'membership-admin',
      name: 'Membership admin',
      description: 'global membership administration',
      rolePermissions: {
        create: permissionIds.map((permissionId) => ({ permissionId })),
      },
    },
  });
  for (const key of ['app-a:member', 'app-a:reviewer']) {
    await prisma.role.create({ data: { key, name: key, description: key, clientId: appA.id } });
  }
  await prisma.role.create({
    data: { key: 'app-b:member', name: 'app-b member', description: 'app-b', clientId: appB.id },
  });

  const makeUser = (username: string) =>
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
  const admin = await makeUser('admin');
  const appBAdmin = await makeUser('app-b-admin');
  await prisma.assignment.create({
    data: {
      subjectType: 'user',
      subjectId: admin.id,
      roleId: adminRole.id,
      scopeType: 'global',
      assignedBy: admin.id,
    },
  });

  state = {
    appAId: appA.id,
    appBId: appB.id,
    adminUserId: admin.id,
    appBAdminUserId: appBAdmin.id,
  };
});

beforeEach(async () => {
  sentInvites.length = 0;
  mailFailure = false;
  const contextIds = (
    await prisma.clientLoginContext.findMany({
      where: { clientId: { in: [state.appAId, state.appBId] } },
      select: { id: true },
    })
  ).map((row) => row.id);
  await prisma.clientMembership.deleteMany({
    where: { clientId: { in: [state.appAId, state.appBId] } },
  });
  await prisma.clientLoginContext.deleteMany({ where: { id: { in: contextIds } } });
  await prisma.client.updateMany({
    where: { id: { in: [state.appAId, state.appBId] } },
    data: { defaultLoginContextKey: null },
  });
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

const createContext = async (key: string, overrides: Record<string, unknown> = {}) =>
  api()
    .post(contextPath('app-a'))
    .set('Authorization', await globalAuth())
    .send(contextBody(key, overrides));

describe('login context lifecycle', () => {
  it('re-opens a disabled context and audits the change', async () => {
    // The first context of a client is its default and the default cannot be disabled.
    await createContext('customer-admin');
    expect((await createContext('customer-team')).status).toBe(201);

    const disabled = await api()
      .post(`${contextPath('app-a')}/customer-team/disable`)
      .set('Authorization', await globalAuth())
      .expect(200);
    expect(disabled.body.status).toBe('disabled');

    const enabled = await api()
      .post(`${contextPath('app-a')}/customer-team/enable`)
      .set('Authorization', await globalAuth())
      .expect(200);
    expect(enabled.body.status).toBe('active');

    const row = await prisma.clientLoginContext.findFirstOrThrow({
      where: { clientId: state.appAId, key: 'customer-team' },
      select: { status: true },
    });
    expect(row.status).toBe('active');

    const events = await prisma.auditEvent.findMany({
      where: {
        clientId: state.appAId,
        action: { in: ['client.context.disabled', 'client.context.enabled'] },
        result: 'success',
      },
      select: { action: true, metadata: true },
    });
    expect(events.map((event) => event.action).sort()).toEqual([
      'client.context.disabled',
      'client.context.enabled',
    ]);
    for (const event of events) {
      expect((event.metadata as Record<string, unknown>)['key']).toBe('customer-team');
    }
  });

  it('requires a fresh authentication to re-open a context', async () => {
    await createContext('customer-admin');
    await createContext('customer-team');
    await api()
      .post(`${contextPath('app-a')}/customer-team/disable`)
      .set('Authorization', await globalAuth())
      .expect(200);

    const stale = await api()
      .post(`${contextPath('app-a')}/customer-team/enable`)
      .set('Authorization', await globalAuth(staleAuthTime()));
    expect(stale.status).toBe(403);
    expect(stale.body.detail).toContain('recent authentication');

    const row = await prisma.clientLoginContext.findFirstOrThrow({
      where: { clientId: state.appAId, key: 'customer-team' },
      select: { status: true },
    });
    expect(row.status).toBe('disabled');
  });

  it('returns 404 when enabling an unknown context', async () => {
    const response = await api()
      .post(`${contextPath('app-a')}/ghost/enable`)
      .set('Authorization', await globalAuth());
    expect(response.status).toBe(404);
  });
});

describe('denied context calls are audited', () => {
  it('writes a failure row with the attempted operation and the actor on a 403', async () => {
    await createContext('customer-team');

    const denied = await api()
      .get(`${contextPath('app-a')}/customer-team`)
      .set('Authorization', await appBAdminAuth());
    expect(denied.status).toBe(403);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'client.context.denied', result: 'failure', clientId: state.appAId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event.actorType).toBe('admin');
    expect(event.actorId).toBe(state.appBAdminUserId);
    expect(event.targetType).toBe('login_context');
    expect(event.targetId).toBeNull();
    const metadata = event.metadata as Record<string, unknown>;
    expect(metadata['attempted']).toBe('read');
    expect(metadata['status']).toBe(403);
    expect(metadata['key']).toBe('customer-team');
  });

  it('records an anonymous denial when no token was presented', async () => {
    await api().get(`${contextPath('app-a')}`).expect(401);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'client.context.denied', result: 'failure', clientId: state.appAId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event.actorType).toBe('anonymous');
    expect(event.actorId).toBeNull();
    expect((event.metadata as Record<string, unknown>)['attempted']).toBe('list');
  });
});

describe('overlapping allowed_roles', () => {
  it('keeps the role of a sibling context when one membership is deleted', async () => {
    await createContext('customer-team');
    await createContext('customer-admin');

    const inviteTo = async (key: string) =>
      api()
        .post(`${membersPath('app-a', key)}/invite`)
        .set('Authorization', await globalAuth())
        .send({ email: 'shared-role@example.com', roleKeys: ['app-a:member'] })
        .expect(201);

    const teamMembership = await inviteTo('customer-team');
    const adminMembership = await inviteTo('customer-admin');
    const userId = teamMembership.body.member.userId as string;
    expect(adminMembership.body.member.userId).toBe(userId);

    for (const key of ['customer-team', 'customer-admin']) {
      await api()
        .patch(`${membersPath('app-a', key)}/${userId}`)
        .set('Authorization', await globalAuth())
        .send({ status: 'active' })
        .expect(200);
    }

    // Two independent grants of the same role, one per membership.
    const grants = await prisma.assignment.findMany({
      where: { subjectType: 'user', subjectId: userId, sourceMembershipId: { not: null } },
      select: { sourceMembershipId: true },
    });
    expect(grants).toHaveLength(2);

    expect(
      (await effectiveAccess.resolve({ userId, clientId: 'app-a', loginContext: 'customer-team' }))
        .roles,
    ).toEqual(['app-a:member']);

    await api()
      .delete(`${membersPath('app-a', 'customer-team')}/${userId}`)
      .set('Authorization', await globalAuth())
      .expect(204);

    const sibling = await effectiveAccess.resolve({
      userId,
      clientId: 'app-a',
      loginContext: 'customer-admin',
    });
    expect(sibling.roles).toEqual(['app-a:member']);
    expect(sibling.membership?.context).toBe('customer-admin');
  });
});

describe('context invitation resend', () => {
  const inviteToTeam = async (email: string) =>
    api()
      .post(`${membersPath('app-a', 'customer-team')}/invite`)
      .set('Authorization', await globalAuth())
      .send({ email, roleKeys: ['app-a:member'] })
      .expect(201);

  it('re-sends a context invitation and audits the delivery', async () => {
    await createContext('customer-team');
    const invited = await inviteToTeam('resend@example.com');
    const userId = invited.body.member.userId as string;
    sentInvites.length = 0;

    const resent = await api()
      .post(`${membersPath('app-a', 'customer-team')}/${userId}/invite/resend`)
      .set('Authorization', await globalAuth())
      .expect(202);
    expect(resent.body).toEqual({ status: 'accepted', delivery: 'invitation' });
    expect(sentInvites).toEqual([userId]);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'member.invite.resend', clientId: state.appAId, actorId: state.adminUserId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event.result).toBe('success');
    expect((event.metadata as Record<string, unknown>)['loginContext']).toBe('customer-team');
  });

  it('rate-limits the resend per context and answers 404/409 for the wrong membership', async () => {
    await createContext('customer-team');
    const invited = await inviteToTeam('resend-limited@example.com');
    const userId = invited.body.member.userId as string;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await api()
        .post(`${membersPath('app-a', 'customer-team')}/${userId}/invite/resend`)
        .set('Authorization', await globalAuth())
        .expect(202);
    }
    const limited = await api()
      .post(`${membersPath('app-a', 'customer-team')}/${userId}/invite/resend`)
      .set('Authorization', await globalAuth());
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('3600');

    // The context key and the user must both name a membership of that context.
    await api()
      .post(`${membersPath('app-a', 'customer-team')}/00000000-0000-0000-0000-000000000000/invite/resend`)
      .set('Authorization', await globalAuth())
      .expect(404);

    await api()
      .patch(`${membersPath('app-a', 'customer-team')}/${userId}`)
      .set('Authorization', await globalAuth())
      .send({ status: 'active' })
      .expect(200);
    const notInvited = await api()
      .post(`${membersPath('app-a', 'customer-team')}/${userId}/invite/resend`)
      .set('Authorization', await globalAuth());
    expect(notInvited.status).toBe(409);
  });

  it('reports a transport failure as 503 and audits it', async () => {
    await createContext('customer-team');
    const invited = await inviteToTeam('resend-failure@example.com');
    const userId = invited.body.member.userId as string;

    mailFailure = true;
    const failed = await api()
      .post(`${membersPath('app-a', 'customer-team')}/${userId}/invite/resend`)
      .set('Authorization', await globalAuth());
    expect(failed.status).toBe(503);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: {
        action: 'member.invite.resend_failed',
        clientId: state.appAId,
        actorId: state.adminUserId,
      },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event.result).toBe('success');
  });
});

describe('context branding is validated on write', () => {
  it('rejects raw CSS, unknown keys and an unsafe logo with 422', async () => {
    const raw = await createContext('customer-team', { branding: { rawCss: 'body{}' } });
    expect(raw.status).toBe(422);
    expect(raw.body.detail).toContain('branding');

    const logo = await createContext('customer-team', {
      branding: { logoUrl: 'javascript:alert(1)' },
    });
    expect(logo.status).toBe(422);
    expect(logo.body.detail).toContain('branding.logoUrl');

    const theme = await createContext('customer-team', {
      branding: { theme: { primary: 'url(javascript:alert(1))' } },
    });
    expect(theme.status).toBe(422);
    expect(theme.body.detail).toContain('branding.theme.primary');

    const stored = await prisma.clientLoginContext.count({
      where: { clientId: state.appAId, key: 'customer-team' },
    });
    expect(stored).toBe(0);
  });

  it('accepts the documented branding shape', async () => {
    const created = await createContext('customer-team', {
      branding: {
        title: 'Customer team',
        logoUrl: 'https://cdn.example.com/team.svg',
        theme: { primary: '#0f766e' },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.branding).toEqual({
      title: 'Customer team',
      logoUrl: 'https://cdn.example.com/team.svg',
      theme: { primary: '#0f766e' },
    });
  });

  it('rejects an invalid branding on patch without touching the stored row', async () => {
    await createContext('customer-team', { branding: { title: 'Team' } });

    const patched = await api()
      .patch(`${contextPath('app-a')}/customer-team`)
      .set('Authorization', await globalAuth())
      .send({ branding: { title: 'Team', rawCss: 'body{}' } });
    expect(patched.status).toBe(422);

    const row = await prisma.clientLoginContext.findFirstOrThrow({
      where: { clientId: state.appAId, key: 'customer-team' },
      select: { branding: true },
    });
    expect(row.branding).toEqual({ title: 'Team' });
  });
});
