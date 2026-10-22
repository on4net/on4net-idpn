import { randomBytes } from 'node:crypto';

import type { AdminRbacRepository } from '../admin/rbac/rbac-types.js';
import { normalizeEmail } from '../auth/normalize.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { SocialProviderId } from './types.js';
import type {
  CreateSocialMembershipInput,
  CreateSocialUserInput,
  LinkIdentityOutcome,
  SocialClient,
  SocialIdentity,
  SocialLoginRepository,
  SocialMembership,
  SocialProviderCredentials,
  SocialUser,
} from './social-login-types.js';

const USER_SELECT = {
  id: true,
  tenantId: true,
  email: true,
  emailVerifiedAt: true,
  status: true,
  deletedAt: true,
} as const;

const usernameFromEmail = (email: string): string => {
  const local = email.split('@')[0] ?? '';
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 48);
  return cleaned.length >= 3 ? cleaned : 'user';
};

/** Prisma reports unique-constraint violations with `code: 'P2002'`. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

export interface PrismaSocialLoginRepositoryOptions {
  /** Assigns the client's default roles on the first membership (`docs/auth-flows.md` 8.7). */
  rbac?: Pick<AdminRbacRepository, 'assignDefaultRoles'>;
}

/**
 * Prisma-backed social login store.
 *
 * Unique-constraint races are part of the protocol, not an error path: a concurrent callback
 * may create the same identity, user or membership. Each create therefore re-reads on `P2002`
 * and reports the outcome, so the route can continue idempotently or return a safe conflict.
 */
export function createPrismaSocialLoginRepository(
  prisma: PrismaClient,
  options: PrismaSocialLoginRepositoryOptions = {},
): SocialLoginRepository {
  const findUserByEmail = async (tenantId: string, email: string): Promise<SocialUser | null> =>
    prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: normalizeEmail(email) } },
      select: USER_SELECT,
    });

  const uniqueUsername = async (tenantId: string, base: string): Promise<string> => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await prisma.user.findUnique({
        where: { tenantId_username: { tenantId, username: candidate } },
        select: { id: true },
      });
      if (taken === null) {
        return candidate;
      }
    }
    return `${base}-${randomBytes(4).toString('hex')}`;
  };

  const findMembership = async (
    clientId: string,
    userId: string,
  ): Promise<SocialMembership | null> =>
    prisma.clientMembership.findFirst({
      where: { clientId, userId, loginContextId: null },
      select: { id: true, status: true },
    });

  return {
    async findClient(clientId: string): Promise<SocialClient | null> {
      return prisma.client.findUnique({
        where: { clientId },
        select: {
          id: true,
          clientId: true,
          tenantId: true,
          status: true,
          registrationPolicy: true,
          allowedEmailDomains: true,
          scopes: true,
        },
      });
    },

    async findProvider(
      clientId: string,
      provider: SocialProviderId,
    ): Promise<SocialProviderCredentials | null> {
      const client = await prisma.client.findUnique({
        where: { clientId },
        select: { id: true },
      });
      if (client === null) {
        return null;
      }
      return prisma.clientSocialProvider.findUnique({
        where: { clientId_provider: { clientId: client.id, provider } },
        select: {
          clientKey: true,
          clientSecretEncrypted: true,
          scopes: true,
          allowedEmailDomains: true,
          enabled: true,
        },
      });
    },

    async findIdentity(
      provider: SocialProviderId,
      providerUserId: string,
    ): Promise<SocialIdentity | null> {
      return prisma.identity.findUnique({
        where: { provider_providerUserId: { provider, providerUserId } },
        select: { userId: true },
      });
    },

    findUserByEmail,

    async findUserById(userId: string): Promise<SocialUser | null> {
      return prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT });
    },

    async createUser(input: CreateSocialUserInput) {
      const email = normalizeEmail(input.email);
      const username = await uniqueUsername(input.tenantId, usernameFromEmail(email));
      try {
        const user = await prisma.user.create({
          data: {
            tenantId: input.tenantId,
            username,
            email,
            displayName: input.displayName,
            avatarUrl: input.avatarUrl,
            locale: input.locale ?? 'fa-IR',
            status: 'active',
            emailVerifiedAt: input.emailVerified ? input.now : null,
          },
          select: USER_SELECT,
        });
        return { user, created: true };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        // A concurrent callback created a user with this email (or the address belongs to a
        // soft-deleted account). Never retry blindly: hand the existing row to the policy.
        const existing = await findUserByEmail(input.tenantId, email);
        if (existing === null) {
          throw error;
        }
        return { user: existing, created: false };
      }
    },

    async linkIdentity(input): Promise<LinkIdentityOutcome> {
      try {
        await prisma.identity.create({
          data: {
            userId: input.userId,
            provider: input.provider,
            providerUserId: input.providerUserId,
            // Provider profiles are not persisted (`docs/auth-flows.md` 9.4).
            metadata: {},
            createdAt: input.now,
          },
        });
        return { ok: true, created: true };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        const existing = await prisma.identity.findUnique({
          where: {
            provider_providerUserId: {
              provider: input.provider,
              providerUserId: input.providerUserId,
            },
          },
          select: { userId: true },
        });
        if (existing === null) {
          // The other unique constraint `[userId, provider]` fired: this user already linked a
          // different account of the same provider. Support must resolve it manually.
          return { ok: false, reason: 'conflict' };
        }
        return existing.userId === input.userId
          ? { ok: true, created: false }
          : { ok: false, reason: 'conflict' };
      }
    },

    findMembership,

    async createMembership(input: CreateSocialMembershipInput): Promise<SocialMembership> {
      try {
        return await prisma.clientMembership.create({
          data: {
            clientId: input.clientId,
            userId: input.userId,
            status: 'active',
            joinedAt: input.joinedAt,
          },
          select: { id: true, status: true },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        const existing = await findMembership(input.clientId, input.userId);
        if (existing === null) {
          throw error;
        }
        return existing;
      }
    },

    async activateMembership(membershipId: string, at: Date): Promise<SocialMembership> {
      return prisma.clientMembership.update({
        where: { id: membershipId },
        data: { status: 'active', joinedAt: at },
        select: { id: true, status: true },
      });
    },

    async assignDefaultRoles(input: { clientId: string; userId: string }): Promise<string[]> {
      if (options.rbac === undefined) {
        return [];
      }
      // `assigned_by` is a polymorphic UUID without a foreign key; a self-service login is
      // recorded as assigned by the user themselves.
      return options.rbac.assignDefaultRoles({
        clientId: input.clientId,
        userId: input.userId,
        assignedBy: input.userId,
      });
    },

    async markLogin(userId: string, at: Date): Promise<void> {
      await prisma.user.update({
        where: { id: userId },
        data: { lastLoginAt: at, failedLoginCount: 0 },
      });
    },

    async releaseUnlinkedUser(userId: string): Promise<void> {
      await prisma.user.deleteMany({
        where: {
          id: userId,
          identities: { none: {} },
          memberships: { none: {} },
          sessions: { none: {} },
        },
      });
    },
  };
}
