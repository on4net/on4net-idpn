import { seedCatalog } from '../db/catalog.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { maskEmail } from '../auth/normalize.js';
import type { InstallInput, InstallOutcome, SetupStore } from './setup-types.js';

const SUPERADMIN_ROLE = 'idp:superadmin';

/**
 * PostgreSQL-backed install. The `system_install` primary key is the lock: the first
 * transaction inserts the marker, any concurrent one blocks on the unique key and then sees
 * zero inserted rows, so exactly one completion can win and the catalog, the administrator and
 * the marker land together or not at all.
 */
export function createPrismaSetupStore(prisma: PrismaClient): SetupStore {
  return {
    async isInstalled() {
      return (await prisma.systemInstall.count()) > 0;
    },

    async install(input: InstallInput): Promise<InstallOutcome> {
      return prisma
        .$transaction(
          async (tx): Promise<InstallOutcome> => {
            const claimed = await tx.$executeRaw`
            INSERT INTO "system_install" ("source") VALUES ('wizard')
            ON CONFLICT ("installed") DO NOTHING
          `;
            if (claimed === 0) {
              return { ok: false, reason: 'already_installed' };
            }

            const { tenantId, roleIds } = await seedCatalog(tx, {
              includeTestUsers: false,
              ...(input.adminUrl === undefined ? {} : { adminUrl: input.adminUrl }),
            });
            const roleId = roleIds.get(SUPERADMIN_ROLE);
            if (roleId === undefined) {
              throw new Error(`catalog is missing role ${SUPERADMIN_ROLE}`);
            }

            const existing = await tx.user.findFirst({
              where: {
                tenantId,
                OR: [{ email: input.email }, { username: input.username }],
              },
              select: { id: true, email: true, username: true, passwordHash: true },
            });
            // A user left behind by `db:seed` has no credential and may be adopted; anything
            // that already holds a password is somebody else's account.
            if (existing !== null && existing.passwordHash !== null) {
              throw new ConflictAbort();
            }
            if (
              existing !== null &&
              (existing.email !== input.email || existing.username !== input.username)
            ) {
              throw new ConflictAbort();
            }

            const now = new Date();
            const user =
              existing === null
                ? await tx.user.create({
                    data: {
                      tenantId,
                      username: input.username,
                      email: input.email,
                      emailVerifiedAt: now,
                      displayName: input.displayName,
                      status: 'active',
                      passwordHash: input.passwordHash,
                      passwordChangedAt: now,
                    },
                    select: { id: true },
                  })
                : await tx.user.update({
                    where: { id: existing.id },
                    data: {
                      displayName: input.displayName,
                      emailVerifiedAt: now,
                      status: 'active',
                      deletedAt: null,
                      passwordHash: input.passwordHash,
                      passwordChangedAt: now,
                    },
                    select: { id: true },
                  });

            await tx.$executeRaw`
            INSERT INTO "assignments"
              ("subject_type", "subject_id", "role_id", "scope_type", "scope_id",
               "source_membership_id", "assigned_by")
            VALUES ('user', ${user.id}::uuid, ${roleId}::uuid, 'global', NULL, NULL, ${user.id}::uuid)
            ON CONFLICT ("subject_type", "subject_id", "role_id", "scope_type", "scope_id",
                         "source_membership_id") DO NOTHING
          `;
            await tx.$executeRaw`
            UPDATE "system_install" SET "installed_by" = ${user.id}::uuid
          `;
            await tx.auditEvent.create({
              data: {
                actorType: 'anonymous',
                action: 'setup.install',
                targetType: 'user',
                targetId: user.id,
                ip: input.ip ?? null,
                userAgent: input.userAgent ?? null,
                result: 'success',
                metadata: {
                  email: maskEmail(input.email),
                  adminUrlConfigured: input.adminUrl !== undefined,
                },
              },
            });
            return { ok: true, userId: user.id };
          },
          { timeout: 120_000 },
        )
        .catch((error: unknown) => {
          if (error instanceof ConflictAbort) {
            return { ok: false, reason: 'conflict' } as const;
          }
          throw error;
        });
    },
  };
}

/** Rolls the whole install back (including the marker) when the account cannot be created. */
class ConflictAbort extends Error {
  constructor() {
    super('install conflict');
  }
}
