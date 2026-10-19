import type { PrismaClient } from '../../generated/prisma/client.js';
import type {
  AdminClientDetail,
  AdminClientRepository,
  AdminClientSummary,
  ClientSecretSummary,
  CreateClientInput,
  UpdateClientInput,
} from './client-types.js';

interface ClientRow {
  clientId: string;
  name: string;
  type: AdminClientSummary['type'];
  status: AdminClientSummary['status'];
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  allowedOrigins: string[];
  scopes: string[];
  accessTokenTtl: number;
  refreshTokenTtl: number;
  requirePkce: boolean;
  registrationPolicy: AdminClientSummary['registrationPolicy'];
  mfaPolicy: AdminClientSummary['mfaPolicy'];
  backchannelLogoutUri: string | null;
  frontchannelLogoutUri: string | null;
  allowedEmailDomains: string[];
  locales: unknown;
  branding: unknown;
  mfeFeatures: unknown;
  membershipSchema: unknown;
  defaultLoginContextKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  clientId: true,
  name: true,
  type: true,
  status: true,
  redirectUris: true,
  postLogoutRedirectUris: true,
  allowedOrigins: true,
  scopes: true,
  accessTokenTtl: true,
  refreshTokenTtl: true,
  requirePkce: true,
  registrationPolicy: true,
  mfaPolicy: true,
  backchannelLogoutUri: true,
  frontchannelLogoutUri: true,
  allowedEmailDomains: true,
  locales: true,
  branding: true,
  mfeFeatures: true,
  membershipSchema: true,
  defaultLoginContextKey: true,
  createdAt: true,
  updatedAt: true,
} as const;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const toSummary = (row: ClientRow): AdminClientSummary => ({
  clientId: row.clientId,
  name: row.name,
  type: row.type,
  status: row.status,
  redirectUris: row.redirectUris,
  postLogoutRedirectUris: row.postLogoutRedirectUris,
  allowedOrigins: row.allowedOrigins,
  scopes: row.scopes,
  accessTokenTtl: row.accessTokenTtl,
  refreshTokenTtl: row.refreshTokenTtl,
  requirePkce: row.requirePkce,
  registrationPolicy: row.registrationPolicy,
  mfaPolicy: row.mfaPolicy,
  backchannelLogoutUri: row.backchannelLogoutUri,
  frontchannelLogoutUri: row.frontchannelLogoutUri,
  allowedEmailDomains: row.allowedEmailDomains,
  locales: asRecord(row.locales),
  branding: asRecord(row.branding),
  mfeFeatures: asRecord(row.mfeFeatures),
  membershipSchema:
    row.membershipSchema === null || row.membershipSchema === undefined
      ? null
      : asRecord(row.membershipSchema),
  defaultLoginContextKey: row.defaultLoginContextKey,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const SECRET_SELECT = {
  id: true,
  prefix: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
} as const;

const toSecret = (row: {
  id: string;
  prefix: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}): ClientSecretSummary => ({
  id: row.id,
  prefix: row.prefix,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

/** Prisma-backed client administration repository (`docs/api.md` 3.3). */
export function createPrismaAdminClientRepository(
  prisma: PrismaClient,
  options: { tenantSlug?: string } = {},
): AdminClientRepository {
  const tenantSlug = options.tenantSlug ?? 'default';

  const tenantId = async (): Promise<string> => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { slug: tenantSlug },
      select: { id: true },
    });
    return tenant.id;
  };

  const findDetail = async (clientId: string): Promise<AdminClientDetail | null> => {
    const row = await prisma.client.findUnique({
      where: { clientId },
      select: {
        ...SELECT,
        id: true,
        secrets: { select: SECRET_SELECT, orderBy: { createdAt: 'desc' } },
      },
    });
    if (row === null) {
      return null;
    }
    return { ...toSummary(row), id: row.id, secrets: row.secrets.map(toSecret) };
  };

  return {
    async list(input) {
      const where = {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.query === undefined || input.query === ''
          ? {}
          : {
              OR: [
                { clientId: { contains: input.query, mode: 'insensitive' as const } },
                { name: { contains: input.query, mode: 'insensitive' as const } },
              ],
            }),
      };
      const [rows, total] = await Promise.all([
        prisma.client.findMany({
          where,
          select: SELECT,
          orderBy: [{ createdAt: 'desc' }, { clientId: 'asc' }],
          skip: (input.page - 1) * input.limit,
          take: input.limit,
        }),
        prisma.client.count({ where }),
      ]);
      return { items: rows.map(toSummary), total };
    },

    findByClientId: findDetail,

    async create(input: CreateClientInput) {
      const tenant = await tenantId();
      const row = await prisma.client.create({
        data: {
          clientId: input.clientId,
          name: input.name,
          type: input.type,
          redirectUris: input.redirectUris,
          postLogoutRedirectUris: input.postLogoutRedirectUris,
          allowedOrigins: input.allowedOrigins,
          scopes: input.scopes,
          accessTokenTtl: input.accessTokenTtl,
          refreshTokenTtl: input.refreshTokenTtl,
          requirePkce: input.requirePkce,
          registrationPolicy: input.registrationPolicy,
          mfaPolicy: input.mfaPolicy,
          backchannelLogoutUri: input.backchannelLogoutUri,
          frontchannelLogoutUri: input.frontchannelLogoutUri,
          allowedEmailDomains: input.allowedEmailDomains,
          locales: input.locales as never,
          branding: input.branding as never,
          mfeFeatures: input.mfeFeatures as never,
          membershipSchema: (input.membershipSchema ?? undefined) as never,
          tenantId: tenant,
        },
        select: { ...SELECT, id: true },
      });
      return { ...toSummary(row), id: row.id, secrets: [] };
    },

    async update(clientId: string, input: UpdateClientInput) {
      const existing = await prisma.client.findUnique({
        where: { clientId },
        select: { id: true },
      });
      if (existing === null) {
        return null;
      }
      await prisma.client.update({
        where: { clientId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.redirectUris === undefined ? {} : { redirectUris: input.redirectUris }),
          ...(input.postLogoutRedirectUris === undefined
            ? {}
            : { postLogoutRedirectUris: input.postLogoutRedirectUris }),
          ...(input.allowedOrigins === undefined ? {} : { allowedOrigins: input.allowedOrigins }),
          ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
          ...(input.accessTokenTtl === undefined ? {} : { accessTokenTtl: input.accessTokenTtl }),
          ...(input.refreshTokenTtl === undefined
            ? {}
            : { refreshTokenTtl: input.refreshTokenTtl }),
          ...(input.requirePkce === undefined ? {} : { requirePkce: input.requirePkce }),
          ...(input.registrationPolicy === undefined
            ? {}
            : { registrationPolicy: input.registrationPolicy }),
          ...(input.mfaPolicy === undefined ? {} : { mfaPolicy: input.mfaPolicy }),
          ...(input.backchannelLogoutUri === undefined
            ? {}
            : { backchannelLogoutUri: input.backchannelLogoutUri }),
          ...(input.frontchannelLogoutUri === undefined
            ? {}
            : { frontchannelLogoutUri: input.frontchannelLogoutUri }),
          ...(input.allowedEmailDomains === undefined
            ? {}
            : { allowedEmailDomains: input.allowedEmailDomains }),
          ...(input.locales === undefined ? {} : { locales: input.locales as never }),
          ...(input.branding === undefined ? {} : { branding: input.branding as never }),
          ...(input.mfeFeatures === undefined ? {} : { mfeFeatures: input.mfeFeatures as never }),
          ...(input.membershipSchema === undefined
            ? {}
            : { membershipSchema: input.membershipSchema as never }),
        },
      });
      return findDetail(clientId);
    },

    async addSecret(clientId: string, secret) {
      const client = await prisma.client.findUnique({ where: { clientId }, select: { id: true } });
      if (client === null) {
        return null;
      }
      const row = await prisma.clientSecret.create({
        data: {
          clientId: client.id,
          secretHash: secret.secretHash,
          prefix: secret.prefix,
          expiresAt: secret.expiresAt,
        },
        select: SECRET_SELECT,
      });
      return toSecret(row);
    },

    async revokeSecret(clientId: string, secretId: string, at: Date) {
      const client = await prisma.client.findUnique({ where: { clientId }, select: { id: true } });
      if (client === null) {
        return false;
      }
      const result = await prisma.clientSecret.updateMany({
        where: { id: secretId, clientId: client.id, revokedAt: null },
        data: { revokedAt: at },
      });
      return result.count === 1;
    },

    async disable(clientId: string, at: Date) {
      const client = await prisma.client.findUnique({ where: { clientId }, select: { id: true } });
      if (client === null) {
        return null;
      }
      const [codes, refreshTokens, sessions] = await Promise.all([
        prisma.authorizationCode.updateMany({
          where: { clientId: client.id, consumedAt: null },
          data: { consumedAt: at },
        }),
        prisma.refreshToken.updateMany({
          where: { clientId: client.id, revokedAt: null },
          data: { revokedAt: at },
        }),
        prisma.session.updateMany({
          where: { clientId: client.id, revokedAt: null },
          data: { revokedAt: at, revokeReason: 'client_disabled' },
        }),
      ]);
      await prisma.client.update({ where: { clientId }, data: { status: 'disabled' } });
      const detail = await findDetail(clientId);
      if (detail === null) {
        return null;
      }
      return {
        client: detail,
        revokedCodes: codes.count,
        revokedRefreshTokens: refreshTokens.count,
        revokedSessions: sessions.count,
      };
    },
  };
}
