import type { PrismaClient } from '../generated/prisma/client.js';

export type MembershipClaimStatus = 'invited' | 'active' | 'suspended';

export interface MembershipClaim {
  context: string | null;
  status: MembershipClaimStatus;
  attributes: Record<string, unknown>;
}

export interface EffectiveAccess {
  roles: string[];
  permissions: string[];
  membership: MembershipClaim | null;
}

export interface EffectiveAccessInput {
  userId: string;
  /** Public client id of the token audience. */
  clientId: string;
  /** Login Context key requested by the authorization flow. */
  loginContext?: string;
}

export interface EffectiveAccessSource {
  resolve(input: EffectiveAccessInput): Promise<EffectiveAccess>;
}

const EMPTY: EffectiveAccess = { roles: [], permissions: [], membership: null };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Computes the effective roles, permissions and membership claim for one access token
 * (docs/domain-model.md 3.2).
 *
 * - Only non-expired global assignments are considered.
 * - Roles are limited to global roles and roles owned by the token's client.
 * - A Login Context narrows the roles to its `allowed_roles`.
 * - `idp:*` roles/permissions are dropped unless the client is the admin panel, so an app
 *   token can never carry IdP administration data.
 * - A suspended membership yields no roles and no permissions.
 * - A requested Login Context requires an **active** membership for that exact context;
 *   a missing or invited membership yields no roles and no permissions (CTX-003).
 * - Omitting the context is the deterministic legacy path: the client-wide membership
 *   (`login_context_id IS NULL`) applies, roles are not narrowed and no `login_context`
 *   claim is issued. Apps with contexts must always send the parameter (see
 *   `docs/login-contexts.md` 4.1); the Hosted UI selector is tracked separately.
 */
export function createPrismaEffectiveAccessSource(
  prisma: PrismaClient,
  now: () => Date = () => new Date(),
): EffectiveAccessSource {
  return {
    async resolve({ userId, clientId, loginContext }) {
      const client = await prisma.client.findUnique({
        where: { clientId },
        select: {
          id: true,
          scopes: true,
          // Whether the token is for a context-scoped client decides whether the unbound
          // (legacy) path is allowed without a client-wide membership below.
          loginContexts: { where: { status: 'active' }, select: { id: true }, take: 1 },
        },
      });
      if (client === null) {
        return EMPTY;
      }

      const includesIdp = client.scopes.includes('idp.admin');

      const context =
        loginContext === undefined
          ? null
          : await prisma.clientLoginContext.findFirst({
              where: { clientId: client.id, key: loginContext, status: 'active' },
              select: { id: true, key: true, allowedRoles: true },
            });
      if (loginContext !== undefined && context === null) {
        return EMPTY;
      }

      const assignments = await prisma.assignment.findMany({
        where: {
          subjectType: 'user',
          subjectId: userId,
          scopeType: 'global',
          OR: [{ expiresAt: null }, { expiresAt: { gt: now() } }],
        },
        select: {
          role: {
            select: {
              key: true,
              clientId: true,
              rolePermissions: {
                select: { permission: { select: { key: true, clientId: true } } },
              },
            },
          },
        },
      });

      const rolesForClient = assignments
        .map((assignment) => assignment.role)
        .filter((role) => role.clientId === null || role.clientId === client.id)
        .filter((role) => (context === null ? true : context.allowedRoles.includes(role.key)));

      const membership = await prisma.clientMembership.findFirst({
        where: {
          clientId: client.id,
          userId,
          loginContextId: context?.id ?? null,
        },
        select: { status: true, attributes: true, loginContext: { select: { key: true } } },
      });

      // A context is a hard access boundary: without an active membership for that exact
      // context the user gets nothing, even if role assignments exist.
      const suspended = membership?.status === 'suspended';
      const contextMembershipMissing = context !== null && membership?.status !== 'active';
      // For a client that defines active contexts, the unbound path is the client-wide
      // (legacy) membership: if that row is missing or not active there is nothing to
      // resolve. Otherwise omitting `login_context` would return the unnarrowed role set
      // and bypass a context membership that is suspended or was never granted.
      const unboundWithoutMembership =
        loginContext === undefined &&
        context === null &&
        client.loginContexts.length > 0 &&
        membership?.status !== 'active';
      const denied = suspended || contextMembershipMissing || unboundWithoutMembership;

      const roles = denied
        ? []
        : [...new Set(rolesForClient.map((role) => role.key))]
            .filter((key) => includesIdp || !key.startsWith('idp:'))
            .sort();

      const permissions = denied
        ? []
        : [
            ...new Set(
              rolesForClient
                .flatMap((role) => role.rolePermissions.map((entry) => entry.permission))
                .filter(
                  (permission) => permission.clientId === null || permission.clientId === client.id,
                )
                .map((permission) => permission.key),
            ),
          ]
            .filter((key) => includesIdp || !key.startsWith('idp:'))
            .sort();

      return {
        roles,
        permissions,
        membership:
          membership === null
            ? null
            : {
                context: membership.loginContext?.key ?? null,
                status: membership.status as MembershipClaimStatus,
                attributes: isPlainObject(membership.attributes) ? membership.attributes : {},
              },
      };
    },
  };
}
