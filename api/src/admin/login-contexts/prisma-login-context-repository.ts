import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type {
  AdminLoginContext,
  AdminLoginContextRepository,
  CreateLoginContextInput,
  LoginContextResult,
  UpdateLoginContextInput,
} from './login-context-types.js';

/** Prisma reports unique-constraint violations with `code: 'P2002'`. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/** Prisma reports foreign-key violations with `code: 'P2003'`. */
const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2003';

const failure = (
  reason: Extract<LoginContextResult<never>, { ok: false }>['reason'],
  detail: string,
): LoginContextResult<never> => ({ ok: false, reason, detail });

interface LoginContextRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  isDefault: boolean;
  allowedRoles: string[];
  defaultRoles: string[];
  loginMethods: string[];
  mfaPolicy: string;
  registrationPolicy: string;
  allowedEmailDomains: string[];
  sessionIdleTtl: number;
  sessionAbsoluteTtl: number;
  stepUpRequired: boolean;
  branding: unknown;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const asBranding = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const toContext = (row: LoginContextRow): AdminLoginContext => ({
  id: row.id,
  key: row.key,
  name: row.name,
  description: row.description,
  status: row.status as AdminLoginContext['status'],
  isDefault: row.isDefault,
  allowedRoles: [...row.allowedRoles].sort(),
  defaultRoles: [...row.defaultRoles].sort(),
  loginMethods: [...row.loginMethods],
  mfaPolicy: row.mfaPolicy as AdminLoginContext['mfaPolicy'],
  registrationPolicy: row.registrationPolicy as AdminLoginContext['registrationPolicy'],
  allowedEmailDomains: [...row.allowedEmailDomains],
  sessionIdleTtl: row.sessionIdleTtl,
  sessionAbsoluteTtl: row.sessionAbsoluteTtl,
  stepUpRequired: row.stepUpRequired,
  branding: asBranding(row.branding),
  sortOrder: row.sortOrder,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

type UpdateOutcome =
  | { kind: 'ok'; row: LoginContextRow }
  | { kind: 'missing' }
  | { kind: 'default-context' }
  | { kind: 'disabled-default' };

/**
 * Prisma-backed login context administration (docs/api.md 3.3.3).
 *
 * Default handling is the tricky part: `is_default` has a partial unique index and the
 * client carries a mirrored `default_login_context_key` for the public config. Both are
 * written inside one transaction that first locks the client row (`FOR UPDATE`), so two
 * concurrent "make this the default" calls serialize instead of racing past the index.
 *
 * Disable is non-destructive. Delete is refused while memberships can still grant access
 * (`active`/`suspended`); pending `invited` rows are removed with the context they were
 * created for, and the default context can never be deleted — another context must take
 * over first, which keeps "exactly one default" true at every commit.
 */
export function createPrismaLoginContextRepository(
  prisma: PrismaClient,
): AdminLoginContextRepository {
  const resolveClient = (clientId: string) =>
    prisma.client.findUnique({
      where: { clientId },
      select: { id: true, defaultLoginContextKey: true },
    });

  /** Serializes default switches for one client; released at transaction end. */
  const lockClient = async (tx: Prisma.TransactionClient, clientUuid: string): Promise<void> => {
    await tx.$queryRaw`SELECT "id" FROM "clients" WHERE "id" = ${clientUuid}::uuid FOR UPDATE`;
  };

  return {
    async list(clientId) {
      const client = await resolveClient(clientId);
      if (client === null) {
        return failure('client-not-found', 'client does not exist');
      }
      const rows = await prisma.clientLoginContext.findMany({
        where: { clientId: client.id },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
      });
      return { ok: true, value: rows.map((row) => toContext(row)) };
    },

    async find(clientId, key) {
      const client = await resolveClient(clientId);
      if (client === null) {
        return failure('client-not-found', 'client does not exist');
      }
      const row = await prisma.clientLoginContext.findUnique({
        where: { clientId_key: { clientId: client.id, key } },
      });
      return { ok: true, value: row === null ? null : toContext(row) };
    },

    async roleKeys(clientId) {
      const client = await resolveClient(clientId);
      if (client === null) {
        return failure('client-not-found', 'client does not exist');
      }
      const rows = await prisma.role.findMany({
        where: { clientId: client.id, NOT: { key: { startsWith: 'idp:' } } },
        select: { key: true },
        orderBy: { key: 'asc' },
      });
      return { ok: true, value: rows.map((row) => row.key) };
    },

    async create(clientId, input: CreateLoginContextInput) {
      const client = await resolveClient(clientId);
      if (client === null) {
        return failure('client-not-found', 'client does not exist');
      }
      try {
        const row = await prisma.$transaction(async (tx) => {
          await lockClient(tx, client.id);
          const defaults = await tx.clientLoginContext.count({
            where: { clientId: client.id, isDefault: true },
          });
          // The first context of a client becomes the default so the invariant "exactly
          // one default per client" also holds for a freshly created app.
          const isDefault = input.isDefault || defaults === 0;
          if (isDefault) {
            await tx.clientLoginContext.updateMany({
              where: { clientId: client.id, isDefault: true },
              data: { isDefault: false },
            });
          }
          const created = await tx.clientLoginContext.create({
            data: {
              clientId: client.id,
              key: input.key,
              name: input.name,
              description: input.description,
              allowedRoles: input.allowedRoles,
              defaultRoles: input.defaultRoles,
              loginMethods: input.loginMethods,
              mfaPolicy: input.mfaPolicy,
              registrationPolicy: input.registrationPolicy,
              allowedEmailDomains: input.allowedEmailDomains,
              sessionIdleTtl: input.sessionIdleTtl,
              sessionAbsoluteTtl: input.sessionAbsoluteTtl,
              stepUpRequired: input.stepUpRequired,
              branding: (input.branding ?? null) as never,
              sortOrder: input.sortOrder,
              isDefault,
            },
          });
          if (isDefault) {
            await tx.client.update({
              where: { id: client.id },
              data: { defaultLoginContextKey: created.key },
            });
          }
          return created;
        });
        return { ok: true, value: toContext(row) };
      } catch (error) {
        if (isUniqueViolation(error)) {
          return failure('duplicate', 'a login context with this key already exists');
        }
        throw error;
      }
    },

    async update(clientId, key, input: UpdateLoginContextInput) {
      const client = await resolveClient(clientId);
      if (client === null) {
        return failure('client-not-found', 'client does not exist');
      }
      const outcome = await prisma.$transaction(async (tx): Promise<UpdateOutcome> => {
        await lockClient(tx, client.id);
        const existing = await tx.clientLoginContext.findUnique({
          where: { clientId_key: { clientId: client.id, key } },
        });
        if (existing === null) {
          return { kind: 'missing' };
        }
        if (existing.isDefault && input.isDefault === false) {
          return { kind: 'default-context' };
        }
        if (existing.status === 'disabled' && input.isDefault === true) {
          return { kind: 'disabled-default' };
        }

        const makeDefault = input.isDefault === true && !existing.isDefault;
        if (makeDefault) {
          await tx.clientLoginContext.updateMany({
            where: { clientId: client.id, isDefault: true },
            data: { isDefault: false },
          });
        }

        const data: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(input)) {
          if (value !== undefined) {
            data[field] = field === 'branding' ? (value ?? null) : value;
          }
        }
        if (makeDefault) {
          data['isDefault'] = true;
        }

        const row = await tx.clientLoginContext.update({
          where: { id: existing.id },
          data: data as never,
        });
        if (row.isDefault && client.defaultLoginContextKey !== row.key) {
          await tx.client.update({
            where: { id: client.id },
            data: { defaultLoginContextKey: row.key },
          });
        }
        return { kind: 'ok', row };
      });

      switch (outcome.kind) {
        case 'missing':
          return failure('not-found', 'login context does not exist');
        case 'default-context':
          return failure(
            'default-context',
            'a client must keep exactly one default login context; make another context the default first',
          );
        case 'disabled-default':
          return failure(
            'default-context',
            'a disabled login context cannot become the default; enable another active context instead',
          );
        case 'ok':
          return { ok: true, value: toContext(outcome.row) };
      }
    },

    async disable(clientId, key) {
      const client = await resolveClient(clientId);
      if (client === null) {
        return failure('client-not-found', 'client does not exist');
      }
      const outcome = await prisma.$transaction(async (tx): Promise<UpdateOutcome> => {
        await lockClient(tx, client.id);
        const existing = await tx.clientLoginContext.findUnique({
          where: { clientId_key: { clientId: client.id, key } },
        });
        if (existing === null) {
          return { kind: 'missing' };
        }
        if (existing.isDefault) {
          return { kind: 'default-context' };
        }
        if (existing.status === 'disabled') {
          return { kind: 'ok', row: existing };
        }
        const row = await tx.clientLoginContext.update({
          where: { id: existing.id },
          data: { status: 'disabled' },
        });
        return { kind: 'ok', row };
      });

      switch (outcome.kind) {
        case 'missing':
          return failure('not-found', 'login context does not exist');
        case 'default-context':
          return failure(
            'default-context',
            'the default login context cannot be disabled; make another context the default first',
          );
        case 'disabled-default':
          return failure('default-context', 'a disabled login context cannot become the default');
        case 'ok':
          return { ok: true, value: toContext(outcome.row) };
      }
    },

    async remove(clientId, key) {
      const client = await resolveClient(clientId);
      if (client === null) {
        return failure('client-not-found', 'client does not exist');
      }
      let outcome: 'ok' | 'missing' | 'default-context' | 'in-use';
      try {
        outcome = await prisma.$transaction(
          async (tx): Promise<'ok' | 'missing' | 'default-context' | 'in-use'> => {
            await lockClient(tx, client.id);
            const existing = await tx.clientLoginContext.findUnique({
              where: { clientId_key: { clientId: client.id, key } },
            });
            if (existing === null) {
              return 'missing';
            }
            if (existing.isDefault) {
              return 'default-context';
            }
            const blocking = await tx.clientMembership.count({
              where: {
                loginContextId: existing.id,
                status: { in: ['active', 'suspended'] },
              },
            });
            if (blocking > 0) {
              return 'in-use';
            }
            // Pending invitations are tied to this context; suspended/active memberships are
            // kept (and block the delete) so no access history is silently rewritten.
            await tx.clientMembership.deleteMany({
              where: { loginContextId: existing.id, status: 'invited' },
            });
            await tx.clientLoginContext.delete({ where: { id: existing.id } });
            if (client.defaultLoginContextKey === existing.key) {
              await tx.client.update({
                where: { id: client.id },
                data: { defaultLoginContextKey: null },
              });
            }
            return 'ok';
          },
        );
      } catch (error) {
        // A membership created after the count still protects the context via the FK.
        if (isForeignKeyViolation(error)) {
          return failure('in-use', 'login context still has memberships; disable it instead');
        }
        throw error;
      }

      switch (outcome) {
        case 'missing':
          return failure('not-found', 'login context does not exist');
        case 'default-context':
          return failure(
            'default-context',
            'the default login context cannot be deleted; make another context the default first',
          );
        case 'in-use':
          return failure('in-use', 'login context still has memberships; disable it instead');
        default:
          return { ok: true, value: null };
      }
    },
  };
}
