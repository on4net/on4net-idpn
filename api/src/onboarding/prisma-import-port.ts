import { normalizeEmail } from '../auth/normalize.js';
import type { AdminMemberRepository } from '../admin/members/member-types.js';
import type { AccountLifecycle } from '../account/lifecycle.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { ImportRollbackPorts, ImportUserRef, UserImportPorts } from './user-import.js';

/**
 * Prisma adapters for the user-import tooling. The import reuses the Admin API repositories so
 * a migrated membership is indistinguishable from an invited one (same defaults, same roles).
 */

export interface ImportPortDependencies {
  members: Pick<AdminMemberRepository, 'invite' | 'find' | 'remove'>;
  lifecycle: Pick<AccountLifecycle, 'sendInvite' | 'sendVerification'>;
  /** Tenant that owns the central users, by slug (default `default`). */
  tenantSlug?: string;
}

async function resolveTenantId(prisma: PrismaClient, slug: string): Promise<string> {
  const tenant = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
  if (tenant === null) {
    throw new Error(`tenant "${slug}" does not exist`);
  }
  return tenant.id;
}

export function createPrismaUserImportPorts(
  prisma: PrismaClient,
  dependencies: ImportPortDependencies,
): UserImportPorts {
  const tenantSlug = dependencies.tenantSlug ?? 'default';
  let tenantId: string | null = null;
  const tenant = async (): Promise<string> => {
    tenantId ??= await resolveTenantId(prisma, tenantSlug);
    return tenantId;
  };

  return {
    async findUser(email): Promise<ImportUserRef | null> {
      const row = await prisma.user.findFirst({
        where: { tenantId: await tenant(), email: normalizeEmail(email), deletedAt: null },
        select: { id: true, passwordHash: true },
        orderBy: { createdAt: 'asc' },
      });
      return row === null ? null : { id: row.id, hasPassword: row.passwordHash !== null };
    },

    async findMembership(clientId, userId) {
      const member = await dependencies.members.find(clientId, userId);
      return member === null ? null : { membershipId: member.membershipId, status: member.status };
    },

    invite: (clientId, input) => dependencies.members.invite(clientId, input),
    sendInvite: (userId) => dependencies.lifecycle.sendInvite(userId),
    sendVerification: (userId) => dependencies.lifecycle.sendVerification(userId),
  };
}

/** Resolves the operator account recorded as `invited_by`; it must exist in the tenant. */
export async function resolveImportActor(
  prisma: PrismaClient,
  email: string,
  tenantSlug = 'default',
): Promise<string> {
  const tenantId = await resolveTenantId(prisma, tenantSlug);
  const user = await prisma.user.findFirst({
    where: { tenantId, email: normalizeEmail(email), deletedAt: null },
    select: { id: true },
  });
  if (user === null) {
    throw new Error(`actor "${email}" does not exist in tenant "${tenantSlug}"`);
  }
  return user.id;
}

export function createPrismaImportRollbackPorts(
  prisma: PrismaClient,
  dependencies: Pick<ImportPortDependencies, 'members'>,
): ImportRollbackPorts {
  return {
    removeMembership: (clientId, userId) => dependencies.members.remove(clientId, userId),

    async userRemovalBlockers(userId) {
      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          passwordHash: true,
          _count: {
            select: {
              sessions: true,
              refreshTokens: true,
              mfaFactors: true,
              identities: true,
              memberships: true,
            },
          },
        },
      });
      if (row === null) {
        return ['user-not-found'];
      }
      const blockers: string[] = [];
      if (row.passwordHash !== null) {
        blockers.push('local-password');
      }
      if (row._count.sessions > 0) {
        blockers.push('active-sessions');
      }
      if (row._count.refreshTokens > 0) {
        blockers.push('refresh-tokens');
      }
      if (row._count.mfaFactors > 0) {
        blockers.push('mfa-factors');
      }
      if (row._count.identities > 0) {
        blockers.push('linked-identity');
      }
      if (row._count.memberships > 0) {
        blockers.push('memberships');
      }
      return blockers;
    },

    async deleteUser(userId) {
      // The invite mail created account tokens and the default roles created assignments;
      // both reference the user, so they are removed in the same transaction.
      await prisma.$transaction([
        prisma.accountToken.deleteMany({ where: { userId } }),
        prisma.assignment.deleteMany({ where: { subjectType: 'user', subjectId: userId } }),
        prisma.user.delete({ where: { id: userId } }),
      ]);
    },
  };
}
