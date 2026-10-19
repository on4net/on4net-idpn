import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';

import { PrismaClient } from '../src/generated/prisma/client.js';

const BASE_PERMISSIONS = [
  { key: 'idp:user:read', description: 'View users and their profiles' },
  { key: 'idp:user:write', description: 'Create, update and disable users' },
  { key: 'idp:user:reset-password', description: 'Trigger a password reset for a user' },
  { key: 'idp:role:manage', description: 'Manage roles and role assignments' },
  { key: 'idp:client:manage', description: 'Manage clients and their configuration' },
  { key: 'idp:client:read', description: 'View clients and their configuration' },
  { key: 'idp:client:write', description: 'Create or change clients, secrets and MFE settings' },
  { key: 'idp:client-member:manage', description: 'Manage client memberships' },
  { key: 'idp:client-role:manage', description: 'Manage per-client roles' },
  { key: 'idp:social-provider:manage', description: 'Manage per-client social providers' },
  { key: 'idp:session:read', description: 'View active sessions' },
  { key: 'idp:session:revoke', description: 'Revoke sessions' },
  { key: 'idp:audit:read', description: 'Read audit events' },
  { key: 'idp:key:manage', description: 'Manage signing keys' },
  { key: 'idp:mfa:manage', description: 'Manage multi-factor authentication factors' },
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
      'idp:session:revoke',
      'idp:audit:read',
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
};

/**
 * Creates the default tenant, the admin client, the base permission/role catalog and the
 * test users. Every write is an upsert or a presence check, so running it repeatedly
 * converges to the same state without duplicating rows.
 */
export async function seedDatabase(prisma: PrismaClient): Promise<void> {
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
      const existing = await prisma.assignment.findFirst({
        where: {
          subjectType: 'user',
          subjectId: record.id,
          roleId,
          scopeType: 'global',
          scopeId: null,
        },
      });
      if (existing === null) {
        await prisma.assignment.create({
          data: {
            subjectType: 'user',
            subjectId: record.id,
            roleId,
            scopeType: 'global',
            assignedBy: record.id,
          },
        });
      }
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
