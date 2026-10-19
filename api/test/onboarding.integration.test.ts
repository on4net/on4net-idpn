import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAccountLifecycle } from '../src/account/lifecycle.js';
import { createPrismaLifecycleUserStore } from '../src/account/prisma-lifecycle-repository.js';
import { createPrismaAccountTokenStore } from '../src/account/prisma-token-repository.js';
import { createPrismaMemberRepository } from '../src/admin/members/prisma-member-repository.js';
import { createPrismaRbacRepository } from '../src/admin/rbac/prisma-rbac-repository.js';
import { createPrismaSocialProviderRepository } from '../src/admin/social-providers/prisma-social-provider-repository.js';
import { createSecretBox } from '../src/crypto/secret-box.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { RecordingMailer } from '../src/mail/recording-mailer.js';
import {
  parseAppOnboardingConfig,
  type AppOnboardingConfig,
} from '../src/onboarding/app-config.js';
import {
  applyClientOnboarding,
  rollbackClientOnboarding,
  type ClientOnboardingDependencies,
} from '../src/onboarding/client-onboarding.js';
import {
  createPrismaImportRollbackPorts,
  createPrismaUserImportPorts,
  resolveImportActor,
} from '../src/onboarding/prisma-import-port.js';
import { combineCredentialLookups } from '../src/onboarding/social-credentials.js';
import {
  parseUserCsv,
  rollbackUserImport,
  runUserImport,
  type UserImportOptions,
} from '../src/onboarding/user-import.js';

const execFileAsync = promisify(execFile);
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

const issuer = 'https://auth.example.com';
const CLIENT_ID = 'platform-a';
const GOOGLE_KEY = 'fake-platform-a.apps.googleusercontent.com';
const GOOGLE_SECRET = 'fake-platform-a-google-secret';

const configDocument = {
  clientId: CLIENT_ID,
  name: 'Platform A',
  socialProviders: {
    google: {
      enabled: true,
      scopes: ['openid', 'email', 'profile'],
      allowedEmailDomains: ['platform-a.example.com'],
    },
  },
  permissions: [
    { key: 'platform-a:contact:read', description: 'Read contacts' },
    { key: 'platform-a:contact:write', description: 'Write contacts' },
  ],
  roles: [
    {
      key: 'platform-a:member',
      name: 'Member',
      description: 'Default member role',
      permissions: ['platform-a:contact:read'],
    },
    {
      key: 'platform-a:user-admin',
      name: 'User administrator',
      description: 'Delegated user administration',
      permissions: ['idp:client-member:read', 'idp:client-member:invite'],
    },
  ],
  defaultRole: 'platform-a:member',
  userAdminRole: 'platform-a:user-admin',
};

/** Rollback is exercised on its own client so it cannot mask another test's state. */
const rollbackDocument = {
  ...configDocument,
  clientId: 'platform-b',
  name: 'Platform B',
  permissions: [{ key: 'platform-b:contact:read', description: 'Read contacts' }],
  roles: [
    {
      key: 'platform-b:member',
      name: 'Member',
      description: 'Default member role',
      permissions: ['platform-b:contact:read'],
    },
    {
      key: 'platform-b:user-admin',
      name: 'User administrator',
      description: 'Delegated user administration',
      permissions: ['idp:client-member:read'],
    },
  ],
  defaultRole: 'platform-b:member',
  userAdminRole: 'platform-b:user-admin',
  socialProviders: { google: { enabled: true } },
};

const parse = (value: unknown): AppOnboardingConfig => {
  const parsed = parseAppOnboardingConfig(value);
  if (parsed.config === null) {
    throw new Error(parsed.problems.join('; '));
  }
  return parsed.config;
};

let container: StartedPostgreSqlContainer | undefined;
let serverClient: Client | undefined;
let scratchDatabase: string | undefined;
let connectionStringValue = '';

let prisma: PrismaClient;
let rbac: ReturnType<typeof createPrismaRbacRepository>;
let providers: ReturnType<typeof createPrismaSocialProviderRepository>;
let members: ReturnType<typeof createPrismaMemberRepository>;
let lifecycle: ReturnType<typeof createAccountLifecycle>;
let mailer: RecordingMailer;
let tenantId: string;
let clientUuid: string;
let actorId: string;
let dependencies: ClientOnboardingDependencies;
let rollbackDependencies: ClientOnboardingDependencies;

const connectionString = (): string => connectionStringValue;

async function migrateDeploy(): Promise<void> {
  await execFileAsync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
}

const countCatalog = async (clientId: string) => ({
  permissions: await prisma.permission.count({ where: { client: { clientId } } }),
  roles: await prisma.role.count({ where: { client: { clientId } } }),
});

const makeUser = async (email: string, options: { password?: boolean } = {}) =>
  prisma.user.create({
    data: {
      tenantId,
      username: email.split('@')[0]!,
      email,
      displayName: email.split('@')[0]!,
      status: 'active',
      ...(options.password === true ? { passwordHash: 'argon2id-placeholder-hash' } : {}),
    },
    select: { id: true },
  });

beforeAll(async () => {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    scratchDatabase = `idpn_onboarding_${Date.now()}`;
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

  const tenant = await prisma.tenant.create({ data: { slug: 'default', name: 'Default' } });
  tenantId = tenant.id;
  const client = await prisma.client.create({
    data: {
      clientId: CLIENT_ID,
      name: 'Platform A',
      type: 'web',
      redirectUris: ['https://platform-a.example.com/auth/callback'],
      postLogoutRedirectUris: ['https://platform-a.example.com/'],
      allowedOrigins: ['https://platform-a.example.com'],
      scopes: ['openid', 'profile', 'email'],
      tenantId,
    },
    select: { id: true },
  });
  clientUuid = client.id;
  await prisma.client.create({
    data: {
      clientId: 'platform-b',
      name: 'Platform B',
      type: 'web',
      redirectUris: ['https://platform-b.example.com/auth/callback'],
      postLogoutRedirectUris: [],
      allowedOrigins: [],
      scopes: ['openid'],
      tenantId,
    },
  });

  // Global permissions the delegated user-admin role links to.
  await prisma.permission.createMany({
    data: [
      { key: 'idp:client-member:read', description: 'Read app members' },
      { key: 'idp:client-member:invite', description: 'Invite app members' },
    ],
  });

  rbac = createPrismaRbacRepository(prisma);
  providers = createPrismaSocialProviderRepository(prisma);
  members = createPrismaMemberRepository(prisma, { rbac });
  mailer = new RecordingMailer();
  lifecycle = createAccountLifecycle({
    users: createPrismaLifecycleUserStore(prisma),
    tokens: createPrismaAccountTokenStore(prisma),
    mailer,
    links: { uiBaseUrl: issuer },
    now: () => new Date('2026-10-19T10:00:00.000Z'),
  });
  actorId = (
    await prisma.user.create({
      data: {
        tenantId,
        username: 'ops',
        email: 'ops@example.com',
        displayName: 'Operator',
        status: 'active',
      },
      select: { id: true },
    })
  ).id;

  const credentials = combineCredentialLookups(null, (clientId, provider) => {
    if (provider !== 'google') {
      return null;
    }
    if (clientId === CLIENT_ID) {
      return { clientKey: GOOGLE_KEY, clientSecret: GOOGLE_SECRET };
    }
    if (clientId === 'platform-b') {
      return { clientKey: 'fake-platform-b.apps.googleusercontent.com', clientSecret: 'fake-b' };
    }
    return null;
  });
  const common: ClientOnboardingDependencies = {
    providers,
    rbac,
    secretBox: createSecretBox(Buffer.alloc(32, 7)),
    issuer,
    credentials,
    nodeEnv: 'test',
    now: () => new Date('2026-10-19T10:00:00.000Z'),
  };
  dependencies = common;
  rollbackDependencies = common;
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (scratchDatabase !== undefined && serverClient !== undefined) {
    await serverClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await serverClient.end();
  }
  await container?.stop();
});

describe('permission mapping', () => {
  it('dry-run reports the plan without writing', async () => {
    const result = await applyClientOnboarding(
      { config: parse(configDocument), dryRun: true, skipSocial: true },
      dependencies,
    );
    expect(result.problems).toEqual([]);
    expect(result.mapping.filter((operation) => operation.action === 'create')).toHaveLength(4);
    expect(await countCatalog(CLIENT_ID)).toEqual({ permissions: 0, roles: 0 });
  });

  it('creates the catalog and converges on a second run', async () => {
    const first = await applyClientOnboarding(
      { config: parse(configDocument), skipSocial: true },
      dependencies,
    );
    expect(first.problems).toEqual([]);
    expect(first.mapping.filter((operation) => operation.action === 'create')).toHaveLength(4);
    expect(await countCatalog(CLIENT_ID)).toEqual({ permissions: 2, roles: 2 });

    const memberRole = await prisma.role.findUniqueOrThrow({
      where: { key: 'platform-a:member' },
      select: {
        isDefault: true,
        rolePermissions: { select: { permission: { select: { key: true } } } },
      },
    });
    expect(memberRole.isDefault).toBe(true);
    expect(memberRole.rolePermissions.map((entry) => entry.permission.key)).toEqual([
      'platform-a:contact:read',
    ]);

    const second = await applyClientOnboarding(
      { config: parse(configDocument), skipSocial: true },
      dependencies,
    );
    expect(second.problems).toEqual([]);
    expect(second.mapping.every((operation) => operation.action === 'unchanged')).toBe(true);
    expect(await countCatalog(CLIENT_ID)).toEqual({ permissions: 2, roles: 2 });
    expect(second.state?.mapping.roles.every((role) => role.existed)).toBe(true);
  });

  it('rejects a key owned by another client before writing anything', async () => {
    const conflicting = parse({
      ...configDocument,
      permissions: [
        ...configDocument.permissions,
        { key: 'platform-b:contact:read', description: 'x' },
      ],
    });
    const result = await applyClientOnboarding(
      { config: conflicting, skipSocial: true },
      dependencies,
    );
    expect(result.problems.join(' ')).toContain('must start with "platform-a"');
    expect(await countCatalog(CLIENT_ID)).toEqual({ permissions: 2, roles: 2 });
  });
});

describe('social provider onboarding', () => {
  it('refuses to write when a credential is missing', async () => {
    const result = await applyClientOnboarding(
      { config: parse(configDocument) },
      { ...dependencies, credentials: () => null },
    );
    expect(result.problems.join(' ')).toContain('no credential configured');
    expect(result.social).toEqual([]);
    expect(await prisma.clientSocialProvider.count({ where: { clientId: clientUuid } })).toBe(0);
  });

  it('stores an encrypted credential and reports the exact callback URL', async () => {
    const result = await applyClientOnboarding({ config: parse(configDocument) }, dependencies);
    expect(result.problems).toEqual([]);
    expect(result.social).toEqual([
      {
        provider: 'google',
        action: 'create',
        callbackUrl: 'https://auth.example.com/oauth2/social/platform-a/google/callback',
        clientKeyHint: `***${GOOGLE_KEY.slice(-4)}`,
        enabled: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(GOOGLE_SECRET);

    const row = await prisma.clientSocialProvider.findFirstOrThrow({
      where: { clientId: clientUuid, provider: 'google' },
    });
    expect(row.clientKey).toBe(GOOGLE_KEY);
    expect(row.allowedEmailDomains).toEqual(['platform-a.example.com']);
    expect(dependencies.secretBox?.decrypt(row.clientSecretEncrypted)).toBe(GOOGLE_SECRET);
  });

  it('updates in place on a second run', async () => {
    const result = await applyClientOnboarding({ config: parse(configDocument) }, dependencies);
    expect(result.problems).toEqual([]);
    expect(result.social[0]?.action).toBe('update');
    expect(await prisma.clientSocialProvider.count({ where: { clientId: clientUuid } })).toBe(1);
  });

  it('rolls back the catalog and credential it created', async () => {
    const applied = await applyClientOnboarding(
      { config: parse(rollbackDocument) },
      rollbackDependencies,
    );
    expect(applied.problems).toEqual([]);
    expect(applied.state).not.toBeNull();
    expect(await countCatalog('platform-b')).toEqual({ permissions: 1, roles: 2 });

    const rolledBack = await rollbackClientOnboarding(
      { state: applied.state! },
      rollbackDependencies,
    );
    expect(rolledBack.problems).toEqual([]);
    expect(rolledBack.social).toEqual([{ provider: 'google', action: 'deleted' }]);
    expect(
      rolledBack.mapping.filter((operation) => operation.kind === 'role').map((o) => o.action),
    ).toEqual(['deleted', 'deleted']);
    expect(
      rolledBack.mapping
        .filter((operation) => operation.kind === 'permission')
        .map((o) => o.action),
    ).toEqual(['deleted']);
    expect(await countCatalog('platform-b')).toEqual({ permissions: 0, roles: 0 });
  });
});

describe('user import', () => {
  const csv = [
    'email,displayName,externalId,roleKeys',
    'new@example.com,New User,legacy-1,platform-a:member',
    'existing@example.com,Existing,legacy-2,',
    'member@example.com,Member,legacy-3,',
    'not-an-email,Broken,legacy-4,',
    'new@example.com,Duplicate,legacy-5,',
  ].join('\n');

  const parsed = () => parseUserCsv(csv, { allowedClients: [CLIENT_ID], defaultClient: CLIENT_ID });

  const runImport = (overrides: Partial<UserImportOptions> = {}) =>
    runUserImport({
      parsed: parsed(),
      allowedClients: [CLIENT_ID],
      actorId,
      ports: createPrismaUserImportPorts(prisma, { members, lifecycle }),
      now: () => new Date('2026-10-19T10:00:00.000Z'),
      ...overrides,
    });

  it('creates password-less users, links existing ones and reports per-row outcomes', async () => {
    const existing = await makeUser('existing@example.com', { password: true });
    const member = await makeUser('member@example.com');
    await prisma.clientMembership.create({
      data: {
        clientId: clientUuid,
        userId: member.id,
        status: 'invited',
        invitedBy: actorId,
        invitedAt: new Date(),
      },
    });
    expect(existing.id).toBeTruthy();
    mailer.clear();

    const summary = await runImport();

    expect(summary.totals).toEqual({
      rows: 5,
      created: 1,
      linked: 1,
      skipped: 1,
      error: 2,
      mailSent: 2,
      mailFailed: 0,
    });
    const created = summary.rows.find((row) => row.email === 'new@example.com');
    expect(created?.status).toBe('created');
    expect(created?.mail).toBe('invitation');

    const user = await prisma.user.findFirstOrThrow({
      where: { tenantId, email: 'new@example.com' },
      select: { id: true, passwordHash: true, status: true },
    });
    expect(user.passwordHash).toBeNull();
    expect(user.status).toBe('pending');

    const membership = await prisma.clientMembership.findFirstOrThrow({
      where: { clientId: clientUuid, userId: user.id, loginContextId: null },
      select: { status: true },
    });
    expect(membership.status).toBe('invited');
    const roles = await prisma.assignment.findMany({
      where: { subjectType: 'user', subjectId: user.id },
      select: { role: { select: { key: true } } },
    });
    expect(roles.map((row) => row.role.key)).toContain('platform-a:member');

    // Mail goes only to created/linked users: the existing member is skipped.
    expect(mailer.sent.map((message) => message.to).sort()).toEqual([
      'existing@example.com',
      'new@example.com',
    ]);

    // No imported row ever ends up with a local password.
    expect(
      await prisma.user.count({
        where: { tenantId, email: { in: ['new@example.com'] }, passwordHash: { not: null } },
      }),
    ).toBe(0);
  });

  it('is idempotent: a second run skips every processed row', async () => {
    mailer.clear();
    const summary = await runImport();
    expect(summary.totals.created).toBe(0);
    expect(summary.totals.linked).toBe(0);
    expect(summary.totals.skipped).toBe(3);
    expect(summary.totals.mailSent).toBe(0);
    expect(mailer.sent).toEqual([]);
    expect(await prisma.clientMembership.count({ where: { clientId: clientUuid } })).toBe(3);
  });

  it('re-sends invitations on demand without creating anything', async () => {
    mailer.clear();
    const summary = await runImport({ resendMail: true });
    expect(summary.totals.skipped).toBe(3);
    expect(summary.totals.mailSent).toBe(3);
    expect(mailer.sent).toHaveLength(3);
  });

  it('performs no writes and sends no mail in dry-run mode', async () => {
    mailer.clear();
    const before = await prisma.user.count({ where: { tenantId } });
    const summary = await runImport({
      dryRun: true,
      parsed: parseUserCsv('email\ndryrun@example.com', {
        allowedClients: [CLIENT_ID],
        defaultClient: CLIENT_ID,
      }),
    });
    expect(summary.rows[0]?.status).toBe('created');
    expect(mailer.sent).toEqual([]);
    expect(await prisma.user.count({ where: { tenantId } })).toBe(before);
  });

  it('rolls back memberships and users created by the run', async () => {
    const summary = await runImport({
      parsed: parseUserCsv('email,externalId\nrollback@example.com,legacy-rb', {
        allowedClients: [CLIENT_ID],
        defaultClient: CLIENT_ID,
      }),
    });
    expect(summary.totals.created).toBe(1);
    const createdUser = await prisma.user.findFirstOrThrow({
      where: { tenantId, email: 'rollback@example.com' },
      select: { id: true },
    });

    const rolledBack = await rollbackUserImport({
      summary,
      ports: createPrismaImportRollbackPorts(prisma, { members }),
    });
    expect(rolledBack.rows[0]?.user).toBe('deleted');
    expect(await prisma.user.count({ where: { id: createdUser.id } })).toBe(0);
    expect(await prisma.clientMembership.count({ where: { userId: createdUser.id } })).toBe(0);
  });

  it('keeps a user that has a local password when rolling back', async () => {
    const summary = await runImport({
      parsed: parseUserCsv('email\nexisting@example.com', {
        allowedClients: [CLIENT_ID],
        defaultClient: CLIENT_ID,
      }),
    });
    const rolledBack = await rollbackUserImport({
      summary: { ...summary, rows: summary.rows.map((row) => ({ ...row, status: 'created' })) },
      ports: createPrismaImportRollbackPorts(prisma, { members }),
    });
    expect(rolledBack.rows[0]?.user).toBe('kept');
    expect(rolledBack.rows[0]?.detail).toContain('local-password');
  });

  it('resolves the operator account for invited_by', async () => {
    expect(await resolveImportActor(prisma, 'ops@example.com')).toBe(actorId);
    await expect(resolveImportActor(prisma, 'missing@example.com')).rejects.toThrow(
      'does not exist',
    );
  });
});
