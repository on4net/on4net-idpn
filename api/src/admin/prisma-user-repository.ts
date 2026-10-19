import type { PrismaClient } from '../generated/prisma/client.js';
import type {
  AdminUser,
  AdminUserRepository,
  AdminUserSession,
  AdminUser as AdminUserRecord,
  CreateUserInput,
  ListUsersQuery,
  UpdateUserInput,
  UserSort,
  UserStatus,
} from './admin-types.js';

/** Raised when the email, username or phone already exists in the tenant. */
export class DuplicateUserError extends Error {
  constructor(
    readonly field: 'email' | 'username' | 'phone' | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'DuplicateUserError';
  }
}

interface UserRow {
  id: string;
  username: string;
  email: string;
  displayName: string;
  phone: string | null;
  locale: string;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  mustChangePassword: boolean;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  username: true,
  email: true,
  displayName: true,
  phone: true,
  locale: true,
  status: true,
  emailVerifiedAt: true,
  mustChangePassword: true,
  lockedUntil: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const toUser = (row: UserRow): AdminUser => ({
  id: row.id,
  username: row.username,
  email: row.email,
  displayName: row.displayName,
  phone: row.phone,
  locale: row.locale,
  status: row.status,
  emailVerified: row.emailVerifiedAt !== null,
  mustChangePassword: row.mustChangePassword,
  lockedUntil: row.lockedUntil?.toISOString() ?? null,
  lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const SORT_CLAUSE: Record<UserSort, Record<string, 'asc' | 'desc'>> = {
  'createdAt:desc': { createdAt: 'desc' },
  'createdAt:asc': { createdAt: 'asc' },
  'lastLoginAt:desc': { lastLoginAt: 'desc' },
  'lastLoginAt:asc': { lastLoginAt: 'asc' },
  'email:asc': { email: 'asc' },
  'email:desc': { email: 'desc' },
};

export interface PrismaAdminUserRepositoryOptions {
  /** Tenant that owns the administered users; single-tenant deployments use `default`. */
  tenantSlug?: string;
}

export function createPrismaAdminUserRepository(
  prisma: PrismaClient,
  options: PrismaAdminUserRepositoryOptions = {},
): AdminUserRepository & { readonly tenantSlug: string } {
  const tenantSlug = options.tenantSlug ?? 'default';

  const tenantId = async (): Promise<string> => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { slug: tenantSlug },
      select: { id: true },
    });
    return tenant.id;
  };

  const findOne = async (userId: string): Promise<AdminUserRecord | null> => {
    const row = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: SELECT,
    });
    return row === null ? null : toUser(row);
  };

  return {
    tenantSlug,

    async list(input: ListUsersQuery) {
      const tenant = await tenantId();
      const where = {
        tenantId: tenant,
        deletedAt: null,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.query === undefined || input.query === ''
          ? {}
          : {
              OR: [
                { email: { contains: input.query, mode: 'insensitive' as const } },
                { username: { contains: input.query, mode: 'insensitive' as const } },
                { displayName: { contains: input.query, mode: 'insensitive' as const } },
              ],
            }),
      };

      const [rows, total] = await Promise.all([
        prisma.user.findMany({
          where,
          select: SELECT,
          orderBy: [{ ...SORT_CLAUSE[input.sort] }, { id: 'asc' }],
          skip: (input.page - 1) * input.limit,
          take: input.limit,
        }),
        prisma.user.count({ where }),
      ]);

      return { items: rows.map(toUser), total };
    },

    findById: findOne,

    async findIdByEmailOrUsername(email, username) {
      const tenant = await tenantId();
      const row = await prisma.user.findFirst({
        where: { tenantId: tenant, deletedAt: null, OR: [{ email }, { username }] },
        select: { id: true },
      });
      return row?.id ?? null;
    },

    async create(input: CreateUserInput) {
      const tenant = await tenantId();
      try {
        const row = await prisma.user.create({
          data: {
            tenantId: tenant,
            username: input.username,
            email: input.email,
            displayName: input.displayName,
            phone: input.phone ?? null,
            locale: input.locale,
            status: input.status,
            passwordHash: input.passwordHash,
            passwordChangedAt: new Date(),
            mustChangePassword: input.mustChangePassword,
          },
          select: SELECT,
        });
        return toUser(row);
      } catch (error) {
        throw toDuplicateError(error);
      }
    },

    async update(userId: string, input: UpdateUserInput) {
      const existing = await findOne(userId);
      if (existing === null) {
        return null;
      }
      try {
        const row = await prisma.user.update({
          where: { id: userId },
          data: {
            ...(input.email === undefined ? {} : { email: input.email }),
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(input.phone === undefined ? {} : { phone: input.phone }),
            ...(input.locale === undefined ? {} : { locale: input.locale }),
            ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
          },
          select: SELECT,
        });
        return toUser(row);
      } catch (error) {
        throw toDuplicateError(error);
      }
    },

    async setStatus(userId: string, status: UserStatus, statusOptions = {}) {
      const existing = await findOne(userId);
      if (existing === null) {
        return null;
      }
      const row = await prisma.user.update({
        where: { id: userId },
        data: {
          status,
          ...(statusOptions.clearLock === true ? { lockedUntil: null, failedLoginCount: 0 } : {}),
        },
        select: SELECT,
      });
      return toUser(row);
    },

    async setPassword(userId: string, passwordHash: string, mustChangePassword: boolean) {
      const existing = await findOne(userId);
      if (existing === null) {
        return null;
      }
      const row = await prisma.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: new Date(), mustChangePassword },
        select: SELECT,
      });
      return toUser(row);
    },

    async listSessions(userId: string): Promise<AdminUserSession[]> {
      const rows = await prisma.session.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          lastSeenAt: true,
          idleExpiresAt: true,
          absoluteExpiresAt: true,
          ip: true,
          userAgent: true,
          amr: true,
          acr: true,
          revokedAt: true,
          revokeReason: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        idleExpiresAt: row.idleExpiresAt.toISOString(),
        absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
        ip: row.ip ?? null,
        userAgent: row.userAgent,
        amr: row.amr,
        acr: row.acr,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        revokeReason: row.revokeReason,
      }));
    },

    async revokeSessions(userId, sessionOptions) {
      const result = await prisma.session.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(sessionOptions.sessionId === undefined ? {} : { id: sessionOptions.sessionId }),
        },
        data: { revokedAt: sessionOptions.revokedAt, revokeReason: sessionOptions.reason },
      });
      return result.count;
    },

    async revokeRefreshTokens(userId, revokedAt) {
      const result = await prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt },
      });
      return result.count;
    },

    async revokeRefreshTokensForSession(sessionId, revokedAt) {
      const result = await prisma.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt },
      });
      return result.count;
    },
  };
}

function toDuplicateError(error: unknown): Error {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code !== 'P2002') {
    return error instanceof Error ? error : new Error('unknown database error');
  }
  const target =
    typeof error === 'object' && error !== null && 'meta' in error
      ? String((error as { meta?: { target?: unknown } }).meta?.target ?? '')
      : '';
  const field = target.includes('email')
    ? 'email'
    : target.includes('username')
      ? 'username'
      : target.includes('phone')
        ? 'phone'
        : 'unknown';
  return new DuplicateUserError(field, `${field} is already taken`);
}
