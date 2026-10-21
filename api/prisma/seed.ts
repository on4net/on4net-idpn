import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';

import { PrismaClient } from '../src/generated/prisma/client.js';
import type { Prisma } from '../src/generated/prisma/client.js';

/**
 * The subset of the client the seed helpers need. They accept a transaction client so the
 * whole seed either lands or leaves the catalog untouched (review finding 6).
 */
type SeedClient = Prisma.TransactionClient;

const BASE_PERMISSIONS = [
  { key: 'idp:user:read', description: 'View users and their profiles' },
  { key: 'idp:user:write', description: 'Create, update and disable users' },
  { key: 'idp:user:invite', description: 'Invite a user to the identity provider' },
  { key: 'idp:user:reset-password', description: 'Trigger a password reset for a user' },
  { key: 'idp:role:read', description: 'View the permission catalog and roles' },
  { key: 'idp:role:write', description: 'Create, update and delete roles and permissions' },
  { key: 'idp:role:manage', description: 'Manage roles and role assignments' },
  { key: 'idp:client:manage', description: 'Manage clients and their configuration' },
  { key: 'idp:client:read', description: 'View clients and their configuration' },
  { key: 'idp:client:write', description: 'Create or change clients, secrets and MFE settings' },
  { key: 'idp:client-member:read', description: 'View members of an app' },
  { key: 'idp:client-member:invite', description: 'Invite members to an app' },
  { key: 'idp:client-member:write', description: 'Change membership status and attributes' },
  { key: 'idp:client-member:manage', description: 'Manage client memberships' },
  { key: 'idp:client-role:read', description: 'View roles of an app' },
  { key: 'idp:client-role:write', description: 'Create or change roles of an app' },
  { key: 'idp:client-role:assign', description: 'Assign or revoke roles of an app' },
  { key: 'idp:client-role:manage', description: 'Manage per-client roles' },
  { key: 'idp:social-provider:read', description: 'View social provider settings of an app' },
  { key: 'idp:social-provider:write', description: 'Change social provider credentials of an app' },
  { key: 'idp:social-provider:manage', description: 'Manage per-client social providers' },
  { key: 'idp:client-session:read', description: 'View sessions of members of an app' },
  { key: 'idp:client-session:write', description: 'Revoke sessions of members of an app' },
  { key: 'idp:client-locale:read', description: 'View locales and translations of an app' },
  { key: 'idp:client-locale:write', description: 'Change locales and translations of an app' },
  { key: 'idp:client-context:read', description: 'View login contexts of an app' },
  { key: 'idp:client-context:write', description: 'Create or change login contexts of an app' },
  { key: 'idp:session:read', description: 'View active sessions' },
  { key: 'idp:session:write', description: 'Revoke sessions and close all user sessions' },
  { key: 'idp:session:revoke', description: 'Revoke sessions' },
  { key: 'idp:audit:read', description: 'Read audit events' },
  { key: 'idp:audit:export', description: 'Export audit events' },
  { key: 'idp:key:read', description: 'View signing key metadata and rotation health' },
  { key: 'idp:key:write', description: 'Rotate signing keys' },
  { key: 'idp:key:manage', description: 'Manage signing keys' },
  { key: 'idp:mfa:manage', description: 'Manage multi-factor authentication factors' },
] as const;

/** Permissions every per-app delegated administrator role receives (docs/domain-model.md 3.4). */
const CLIENT_ADMIN_PERMISSIONS = [
  'idp:client-member:read',
  'idp:client-member:invite',
  'idp:client-member:write',
  'idp:client-role:read',
  'idp:client-role:write',
  'idp:client-role:assign',
  'idp:social-provider:read',
  'idp:social-provider:write',
  'idp:client-session:read',
  'idp:client-session:write',
  'idp:client-locale:read',
  'idp:client-locale:write',
  'idp:client-context:read',
  'idp:client-context:write',
] as const;

const BASE_ROLES = [
  {
    key: 'idp:superadmin',
    name: 'Super Administrator',
    description: 'Full control over the identity provider',
    permissions: BASE_PERMISSIONS.map((permission) => permission.key),
  },
  {
    key: 'idp:security-admin',
    name: 'Security Administrator',
    description: 'Signing keys, sessions, MFA and audit access',
    permissions: [
      'idp:session:read',
      'idp:session:write',
      'idp:session:revoke',
      'idp:audit:read',
      'idp:key:read',
      'idp:key:write',
      'idp:key:manage',
      'idp:mfa:manage',
    ],
  },
  {
    key: 'idp:support',
    name: 'Support',
    description: 'View users and reset passwords without changing roles',
    permissions: ['idp:user:read', 'idp:user:reset-password'],
  },
] as const;

interface SeedUser {
  username: string;
  email: string;
  displayName: string;
  roleKeys: readonly string[];
}

const SEED_USERS: readonly SeedUser[] = [
  {
    username: 'admin',
    email: 'admin@example.com',
    displayName: 'IDPN Super Admin',
    roleKeys: ['idp:superadmin'],
  },
  {
    username: 'support',
    email: 'support@example.com',
    displayName: 'IDPN Support',
    roleKeys: ['idp:support'],
  },
  {
    username: 'user',
    email: 'user@example.com',
    displayName: 'Test User',
    roleKeys: [],
  },
];

const ADMIN_CLIENT = {
  clientId: 'admin-panel',
  name: 'IDPN Admin Panel',
  type: 'web' as const,
  redirectUris: ['http://localhost:3001/auth/callback'],
  postLogoutRedirectUris: ['http://localhost:3001/'],
  allowedOrigins: ['http://localhost:3001'],
  scopes: ['openid', 'profile', 'email', 'idp.admin'],
  mfaPolicy: 'required_all' as const,
  registrationPolicy: 'disabled' as const,
  // The Hosted UI (and the admin panel it serves) ships the fa-IR/en-US base bundles
  // (docs/localization.md 5). Without an explicit allowlist the public config exposes only
  // `fa-IR`, so an `ui_locales=en-US` request would silently fall back to Persian.
  locales: {
    default: 'fa-IR',
    supported: ['fa-IR', 'en-US'],
    dir: { 'fa-IR': 'rtl', 'en-US': 'ltr' },
  },
};

/**
 * Ensures every client has exactly one default login context (docs/roadmap.md Phase 2,
 * docs/api.md 3.3.3). Existing contexts are kept; a missing default is promoted to the
 * first defined context and `clients.default_login_context_key` is kept in sync so the
 * public config always names a context that exists. Idempotent.
 */
async function seedDefaultLoginContext(prisma: SeedClient, clientId: string): Promise<void> {
  const client = await prisma.client.findUniqueOrThrow({
    where: { clientId },
    select: {
      id: true,
      clientId: true,
      mfaPolicy: true,
      registrationPolicy: true,
      defaultLoginContextKey: true,
    },
  });

  const existing = await prisma.clientLoginContext.findMany({
    where: { clientId: client.id },
    select: { id: true, key: true, isDefault: true },
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
  });

  if (existing.length === 0) {
    await prisma.clientLoginContext.create({
      data: {
        clientId: client.id,
        key: 'default',
        name: 'Default',
        description: `Default login for ${client.clientId}`,
        status: 'active',
        isDefault: true,
        allowedRoles: [
          `${client.clientId}:member`,
          `${client.clientId}:viewer`,
          `${client.clientId}:user-admin`,
        ],
        defaultRoles: [`${client.clientId}:member`],
        loginMethods: ['password'],
        mfaPolicy: client.mfaPolicy,
        registrationPolicy: client.registrationPolicy,
        allowedEmailDomains: [],
        sessionIdleTtl: 1800,
        sessionAbsoluteTtl: 28_800,
        stepUpRequired: false,
        sortOrder: 0,
      },
    });
  } else if (!existing.some((context) => context.isDefault)) {
    const target = existing[0];
    if (target !== undefined) {
      await prisma.clientLoginContext.update({
        where: { id: target.id },
        data: { isDefault: true },
      });
    }
  }

  const defaultContext = await prisma.clientLoginContext.findFirst({
    where: { clientId: client.id, isDefault: true },
    select: { key: true },
  });
  if (defaultContext !== null && client.defaultLoginContextKey !== defaultContext.key) {
    await prisma.client.update({
      where: { id: client.id },
      data: { defaultLoginContextKey: defaultContext.key },
    });
  }
}

/**
 * Creates the base roles every client owns. `member` is the default role that is assigned
 * on the first membership; `user-admin` is the delegated administration role. Both are
 * idempotent so the seed can run repeatedly.
 */
async function seedClientRoles(
  prisma: SeedClient,
  clientId: string,
  permissionIds: Map<string, string>,
): Promise<void> {
  const client = await prisma.client.findUniqueOrThrow({
    where: { clientId },
    select: { id: true },
  });

  const roles = [
    {
      key: `${clientId}:member`,
      name: 'Member',
      description: `Default member role for ${clientId}`,
      isDefault: true,
      permissions: [] as string[],
    },
    {
      key: `${clientId}:viewer`,
      name: 'Viewer',
      description: `Read-only role for ${clientId}`,
      isDefault: false,
      permissions: [] as string[],
    },
    {
      key: `${clientId}:user-admin`,
      name: 'User administrator',
      description: `Delegated user administration role for ${clientId}`,
      isDefault: false,
      permissions: [...CLIENT_ADMIN_PERMISSIONS],
    },
  ];

  for (const role of roles) {
    const record = await prisma.role.upsert({
      where: { key: role.key },
      update: {
        name: role.name,
        description: role.description,
        clientId: client.id,
        isDefault: role.isDefault,
      },
      create: {
        key: role.key,
        name: role.name,
        description: role.description,
        clientId: client.id,
        isDefault: role.isDefault,
      },
    });

    await prisma.rolePermission.deleteMany({ where: { roleId: record.id } });
    if (role.permissions.length > 0) {
      await prisma.rolePermission.createMany({
        data: role.permissions.map((key) => {
          const permissionId = permissionIds.get(key);
          if (permissionId === undefined) {
            throw new Error(`Role ${role.key} references unknown permission ${key}`);
          }
          return { roleId: record.id, permissionId };
        }),
      });
    }
  }
}

/**
 * Creates the default tenant, the admin client, the base permission/role catalog and the
 * test users. Every write is an upsert, a presence check or `ON CONFLICT DO NOTHING`, so
 * running it repeatedly converges to the same state without duplicating rows, and the whole
 * catalog is written in one transaction so a mid-run failure cannot leave it partial.
 */
export async function seedDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => seedCatalog(tx), { timeout: 120_000 });
}

async function seedCatalog(prisma: SeedClient): Promise<void> {
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'default' },
    update: { name: 'Default tenant', status: 'active' },
    create: { slug: 'default', name: 'Default tenant', status: 'active' },
  });

  const permissionIds = new Map<string, string>();
  for (const permission of BASE_PERMISSIONS) {
    const record = await prisma.permission.upsert({
      where: { key: permission.key },
      update: { description: permission.description, clientId: null },
      create: { key: permission.key, description: permission.description },
    });
    permissionIds.set(record.key, record.id);
  }

  const roleIds = new Map<string, string>();
  for (const role of BASE_ROLES) {
    const record = await prisma.role.upsert({
      where: { key: role.key },
      update: {
        name: role.name,
        description: role.description,
        clientId: null,
        isDefault: false,
      },
      create: {
        key: role.key,
        name: role.name,
        description: role.description,
        clientId: null,
        isDefault: false,
      },
    });
    roleIds.set(record.key, record.id);

    await prisma.rolePermission.deleteMany({ where: { roleId: record.id } });
    await prisma.rolePermission.createMany({
      data: role.permissions.map((key) => {
        const permissionId = permissionIds.get(key);
        if (permissionId === undefined) {
          throw new Error(`Role ${role.key} references unknown permission ${key}`);
        }
        return { roleId: record.id, permissionId };
      }),
    });
  }

  await prisma.client.upsert({
    where: { clientId: ADMIN_CLIENT.clientId },
    update: { ...ADMIN_CLIENT, tenantId: tenant.id },
    create: { ...ADMIN_CLIENT, tenantId: tenant.id },
  });

  // Every app gets its own base catalog roles: a default member role and the delegated
  // administration role described in docs/domain-model.md 3.4.
  const clients = await prisma.client.findMany({ select: { clientId: true } });
  for (const client of clients) {
    await seedClientRoles(prisma, client.clientId, permissionIds);
    await seedDefaultLoginContext(prisma, client.clientId);
  }

  for (const user of SEED_USERS) {
    // Credentials are provisioned by the password/identity flow; seeded users start
    // without a password hash so that no shared default password exists.
    const record = await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: user.email } },
      update: { displayName: user.displayName, status: 'active', deletedAt: null },
      create: {
        tenantId: tenant.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        status: 'active',
      },
    });

    for (const roleKey of user.roleKeys) {
      const roleId = roleIds.get(roleKey);
      if (roleId === undefined) {
        throw new Error(`User ${user.email} references unknown role ${roleKey}`);
      }
      // The unique tuple is enforced with NULLS NOT DISTINCT (migration 0002), so a single
      // `ON CONFLICT DO NOTHING` replaces the previous check-then-insert race.
      await prisma.$executeRaw`
        INSERT INTO "assignments"
          ("subject_type", "subject_id", "role_id", "scope_type", "scope_id", "assigned_by")
        VALUES ('user', ${record.id}::uuid, ${roleId}::uuid, 'global', NULL, ${record.id}::uuid)
        ON CONFLICT ("subject_type", "subject_id", "role_id", "scope_type", "scope_id") DO NOTHING
      `;
    }
  }
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  loadEnv({ path: resolve(here, '..', '.env'), quiet: true });
  loadEnv({ path: resolve(here, '..', '..', '.env'), quiet: true });

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    await seedDatabase(prisma);
    const [tenants, users, clients, roles, permissions] = await Promise.all([
      prisma.tenant.count(),
      prisma.user.count(),
      prisma.client.count(),
      prisma.role.count(),
      prisma.permission.count(),
    ]);
    console.log(
      `Seed complete: ${tenants} tenant(s), ${users} user(s), ${clients} client(s), ` +
        `${roles} role(s), ${permissions} permission(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
