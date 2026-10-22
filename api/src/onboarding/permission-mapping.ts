import { permissionKeyProblems, roleKeyProblems } from '../admin/rbac/rbac-validation.js';
import type { AdminRbacRepository } from '../admin/rbac/rbac-types.js';
import { CLIENT_ID_PATTERN, type AppOnboardingConfig } from './app-config.js';

/**
 * Applies a per-app permission/role mapping through the existing RBAC repository
 * (`api/src/admin/rbac/prisma-rbac-repository.ts`) so the CLI and the Admin API share one
 * validation and persistence path (`docs/domain-model.md` 3.3-3.4).
 *
 * Two rules keep a mapping from escalating privileges:
 *
 * 1. every permission and role key must start with the app's own `clientId`;
 * 2. a role may only link permissions declared for that app, plus the documented delegated
 *    administration permissions that `api/prisma/seed.ts` also grants to `<clientId>:user-admin`.
 */

/**
 * Global permissions the delegated user-administration role needs (`docs/domain-model.md`
 * 3.4, mirrored from `CLIENT_ADMIN_PERMISSIONS` in `api/prisma/seed.ts`). Anything else with
 * the reserved `idp` prefix is rejected so an app mapping cannot grant IdP-wide power.
 */
export const DELEGATED_ADMIN_PERMISSION_KEYS: readonly string[] = [
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
];

export interface PlannedPermission {
  key: string;
  description: string;
}

export interface PlannedRole {
  key: string;
  name: string;
  description: string;
  isDefault: boolean;
  permissionKeys: string[];
}

export interface MappingPlan {
  clientId: string;
  permissions: PlannedPermission[];
  roles: PlannedRole[];
  defaultRoleKey: string;
  userAdminRoleKey: string;
}

export interface MappingValidation {
  ok: boolean;
  problems: string[];
  plan: MappingPlan | null;
}

const duplicated = (values: string[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort();
};

/**
 * Validates a config document and produces the deterministic plan the apply step consumes.
 * The same function is used for `--dry-run`, so a config that validates is exactly the
 * config that will be applied.
 */
export function planPermissionMapping(config: AppOnboardingConfig): MappingValidation {
  const problems: string[] = [];
  const { clientId } = config;

  if (!CLIENT_ID_PATTERN.test(clientId)) {
    problems.push(`clientId "${clientId}" is not a valid public client id`);
  }

  const permissionKeys = config.permissions.map((permission) => permission.key);
  for (const key of duplicated(permissionKeys)) {
    problems.push(`permission "${key}" is declared more than once`);
  }
  for (const permission of config.permissions) {
    for (const problem of permissionKeyProblems(permission.key, clientId)) {
      problems.push(`permission "${permission.key}": ${problem}`);
    }
  }

  const roleKeys = config.roles.map((role) => role.key);
  for (const key of duplicated(roleKeys)) {
    problems.push(`role "${key}" is declared more than once`);
  }
  for (const role of config.roles) {
    for (const problem of roleKeyProblems(role.key, clientId)) {
      problems.push(`role "${role.key}": ${problem}`);
    }
    for (const key of duplicated(role.permissions)) {
      problems.push(`role "${role.key}" lists permission "${key}" more than once`);
    }
  }

  const appPermissions = new Set(permissionKeys);
  const delegated = new Set(DELEGATED_ADMIN_PERMISSION_KEYS);
  for (const role of config.roles) {
    for (const key of role.permissions) {
      if (appPermissions.has(key) || delegated.has(key)) {
        continue;
      }
      problems.push(
        `role "${role.key}" links permission "${key}" which is neither declared for ` +
          `"${clientId}" nor in the delegated-administration allowlist`,
      );
    }
  }

  const declaredRoles = new Set(roleKeys);
  if (!declaredRoles.has(config.defaultRole)) {
    problems.push(`defaultRole "${config.defaultRole}" is not declared in roles`);
  }
  if (!declaredRoles.has(config.userAdminRole)) {
    problems.push(`userAdminRole "${config.userAdminRole}" is not declared in roles`);
  }
  if (config.defaultRole === config.userAdminRole) {
    problems.push('defaultRole and userAdminRole must be different roles');
  }

  if (problems.length > 0) {
    return { ok: false, problems, plan: null };
  }

  const plan: MappingPlan = {
    clientId,
    permissions: config.permissions.map((permission) => ({
      key: permission.key,
      description: permission.description,
    })),
    roles: config.roles.map((role) => ({
      key: role.key,
      name: role.name,
      description: role.description,
      isDefault: role.key === config.defaultRole,
      permissionKeys: [...new Set(role.permissions)].sort(),
    })),
    defaultRoleKey: config.defaultRole,
    userAdminRoleKey: config.userAdminRole,
  };
  return { ok: true, problems: [], plan };
}

export type MappingActionName =
  'create' | 'update' | 'unchanged' | 'conflict' | 'deleted' | 'restored' | 'kept';

export interface MappingOperation {
  kind: 'permission' | 'role';
  key: string;
  action: MappingActionName;
  detail?: string;
}

export interface MappingRoleState {
  key: string;
  existed: boolean;
  /** Snapshot before the apply step; `null` when the role did not exist. */
  previous: { permissionKeys: string[]; isDefault: boolean } | null;
}

/** Rollback input written next to the onboarding summary; contains no secret material. */
export interface MappingState {
  clientId: string;
  permissions: { key: string; created: boolean }[];
  roles: MappingRoleState[];
}

export interface MappingApplyResult {
  dryRun: boolean;
  problems: string[];
  operations: MappingOperation[];
  state: MappingState | null;
}

const sameKeys = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export interface MappingApplyOptions {
  rbac: AdminRbacRepository;
  plan: MappingPlan;
  dryRun?: boolean;
}

/** Applies the plan; repeated runs converge to the same catalog and report `unchanged`. */
export async function applyPermissionMapping(
  options: MappingApplyOptions,
): Promise<MappingApplyResult> {
  const { rbac, plan } = options;
  const dryRun = options.dryRun ?? false;
  const operations: MappingOperation[] = [];
  const problems: string[] = [];
  const state: MappingState = { clientId: plan.clientId, permissions: [], roles: [] };

  for (const permission of plan.permissions) {
    const page = await rbac.listPermissions({ page: 1, limit: 100, query: permission.key });
    const existing = page.items.find((item) => item.key === permission.key) ?? null;
    if (existing !== null && existing.clientId !== plan.clientId) {
      operations.push({
        kind: 'permission',
        key: permission.key,
        action: 'conflict',
        detail: `owned by "${existing.clientId ?? 'idp'}"`,
      });
      problems.push(
        `permission "${permission.key}" already exists for client ` +
          `"${existing.clientId ?? 'idp'}" and is not owned by "${plan.clientId}"`,
      );
      continue;
    }
    if (existing !== null) {
      operations.push({ kind: 'permission', key: permission.key, action: 'unchanged' });
      state.permissions.push({ key: permission.key, created: false });
      continue;
    }
    if (!dryRun) {
      const created = await rbac.createPermission({
        key: permission.key,
        clientId: plan.clientId,
        description: permission.description,
      });
      if (!created.ok) {
        operations.push({
          kind: 'permission',
          key: permission.key,
          action: 'conflict',
          detail: created.detail,
        });
        problems.push(`permission "${permission.key}": ${created.detail}`);
        continue;
      }
    }
    operations.push({ kind: 'permission', key: permission.key, action: 'create' });
    state.permissions.push({ key: permission.key, created: true });
  }

  if (problems.length > 0) {
    // A partial catalog is never left behind: stop before roles are touched.
    return { dryRun, problems, operations, state: null };
  }

  for (const role of plan.roles) {
    const page = await rbac.listRoles({ page: 1, limit: 100, query: role.key });
    const existing = page.items.find((item) => item.key === role.key) ?? null;
    if (existing !== null && existing.clientId !== plan.clientId) {
      operations.push({
        kind: 'role',
        key: role.key,
        action: 'conflict',
        detail: `owned by "${existing.clientId ?? 'idp'}"`,
      });
      problems.push(
        `role "${role.key}" already exists for client "${existing.clientId ?? 'idp'}" ` +
          `and is not owned by "${plan.clientId}"`,
      );
      continue;
    }

    if (existing === null) {
      if (!dryRun) {
        const created = await rbac.createRole(
          {
            key: role.key,
            name: role.name,
            description: role.description,
            clientId: plan.clientId,
            isDefault: role.isDefault,
            permissionKeys: role.permissionKeys,
          },
          { allowGlobalPermissions: true },
        );
        if (!created.ok) {
          operations.push({
            kind: 'role',
            key: role.key,
            action: 'conflict',
            detail: created.detail,
          });
          problems.push(`role "${role.key}": ${created.detail}`);
          continue;
        }
      }
      operations.push({ kind: 'role', key: role.key, action: 'create' });
      state.roles.push({ key: role.key, existed: false, previous: null });
      continue;
    }

    state.roles.push({
      key: role.key,
      existed: true,
      previous: {
        permissionKeys: [...existing.permissionKeys].sort(),
        isDefault: existing.isDefault,
      },
    });
    const unchanged =
      existing.name === role.name &&
      existing.description === role.description &&
      existing.isDefault === role.isDefault &&
      sameKeys([...existing.permissionKeys].sort(), role.permissionKeys);
    if (unchanged) {
      operations.push({ kind: 'role', key: role.key, action: 'unchanged' });
      continue;
    }
    if (!dryRun) {
      const updated = await rbac.updateRole(existing.id, {
        name: role.name,
        description: role.description,
        isDefault: role.isDefault,
      });
      if (!updated.ok) {
        operations.push({
          kind: 'role',
          key: role.key,
          action: 'conflict',
          detail: updated.detail,
        });
        problems.push(`role "${role.key}": ${updated.detail}`);
        continue;
      }
      const linked = await rbac.replaceRolePermissions(existing.id, role.permissionKeys, {
        allowGlobalPermissions: true,
      });
      if (!linked.ok) {
        operations.push({ kind: 'role', key: role.key, action: 'conflict', detail: linked.detail });
        problems.push(`role "${role.key}": ${linked.detail}`);
        continue;
      }
    }
    operations.push({ kind: 'role', key: role.key, action: 'update' });
  }

  return {
    dryRun,
    problems,
    operations,
    state: problems.length > 0 ? null : state,
  };
}

export interface MappingRollbackOptions {
  rbac: AdminRbacRepository;
  state: MappingState;
  dryRun?: boolean;
}

export interface MappingRollbackResult {
  dryRun: boolean;
  problems: string[];
  operations: MappingOperation[];
}

/**
 * Reverses an apply step from its recorded state: created roles and permissions are deleted
 * when unused, pre-existing roles get their previous permission set back. A role that gained
 * assignments in the meantime is kept (deleting it would revoke access) and reported.
 */
export async function rollbackPermissionMapping(
  options: MappingRollbackOptions,
): Promise<MappingRollbackResult> {
  const { rbac, state } = options;
  const dryRun = options.dryRun ?? false;
  const operations: MappingOperation[] = [];
  const problems: string[] = [];

  for (const roleState of [...state.roles].reverse()) {
    const page = await rbac.listRoles({ page: 1, limit: 100, query: roleState.key });
    const role = page.items.find((item) => item.key === roleState.key) ?? null;
    if (role === null) {
      operations.push({ kind: 'role', key: roleState.key, action: 'unchanged', detail: 'absent' });
      continue;
    }
    if (roleState.previous !== null) {
      if (!dryRun) {
        const restored = await rbac.replaceRolePermissions(
          role.id,
          roleState.previous.permissionKeys,
          { allowGlobalPermissions: true },
        );
        if (!restored.ok) {
          problems.push(`role "${roleState.key}": ${restored.detail}`);
          continue;
        }
        const updated = await rbac.updateRole(role.id, { isDefault: roleState.previous.isDefault });
        if (!updated.ok) {
          problems.push(`role "${roleState.key}": ${updated.detail}`);
          continue;
        }
      }
      operations.push({ kind: 'role', key: roleState.key, action: 'restored' });
      continue;
    }
    if (dryRun) {
      operations.push({ kind: 'role', key: roleState.key, action: 'deleted' });
      continue;
    }
    const deleted = await rbac.deleteRole(role.id);
    if (deleted === 'deleted') {
      operations.push({ kind: 'role', key: roleState.key, action: 'deleted' });
    } else if (deleted === 'in-use') {
      operations.push({
        kind: 'role',
        key: roleState.key,
        action: 'kept',
        detail: 'role has assignments; revoke them before rollback',
      });
    } else {
      operations.push({ kind: 'role', key: roleState.key, action: 'unchanged', detail: 'absent' });
    }
  }

  for (const permissionState of [...state.permissions].reverse()) {
    if (!permissionState.created) {
      continue;
    }
    const page = await rbac.listPermissions({ page: 1, limit: 100, query: permissionState.key });
    const permission = page.items.find((item) => item.key === permissionState.key) ?? null;
    if (permission === null) {
      operations.push({
        kind: 'permission',
        key: permissionState.key,
        action: 'unchanged',
        detail: 'absent',
      });
      continue;
    }
    if (dryRun) {
      operations.push({ kind: 'permission', key: permissionState.key, action: 'deleted' });
      continue;
    }
    const deleted = await rbac.deletePermission(permission.id);
    operations.push({
      kind: 'permission',
      key: permissionState.key,
      action: deleted === 'deleted' ? 'deleted' : 'kept',
      ...(deleted === 'deleted' ? {} : { detail: 'permission is linked to a role' }),
    });
  }

  return { dryRun, problems, operations };
}
