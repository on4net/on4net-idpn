export interface AdminPermission {
  id: string;
  key: string;
  /** Public client id; `null` for a global (`idp:*`) permission. */
  clientId: string | null;
  description: string;
}

export interface AdminRole {
  id: string;
  key: string;
  name: string;
  description: string;
  clientId: string | null;
  isDefault: boolean;
  permissionKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ListCatalogQuery {
  page: number;
  limit: number;
  clientId?: string;
  query?: string;
}

export interface CreatePermissionInput {
  key: string;
  clientId: string | null;
  description: string;
}

export interface CreateRoleInput {
  key: string;
  name: string;
  description: string;
  clientId: string | null;
  isDefault: boolean;
  permissionKeys: string[];
}

export interface UpdateRoleInput {
  name?: string;
  description?: string;
  isDefault?: boolean;
}

export interface AssignDefaultRolesInput {
  clientId: string;
  userId: string;
  assignedBy: string;
}

export type CatalogFailure =
  | 'client-not-found'
  | 'duplicate-key'
  | 'unknown-permission'
  | 'cross-client-permission'
  | 'not-found'
  | 'in-use';

export type CatalogResult<T> =
  { ok: true; value: T } | { ok: false; reason: CatalogFailure; detail: string };

/** Persistence port for the permission catalog and role management endpoints. */
export interface AdminRbacRepository {
  listPermissions(query: ListCatalogQuery): Promise<{ items: AdminPermission[]; total: number }>;
  findPermission(permissionId: string): Promise<AdminPermission | null>;
  createPermission(input: CreatePermissionInput): Promise<CatalogResult<AdminPermission>>;
  deletePermission(permissionId: string): Promise<'deleted' | 'not-found' | 'in-use'>;

  listRoles(query: ListCatalogQuery): Promise<{ items: AdminRole[]; total: number }>;
  findRole(roleId: string): Promise<AdminRole | null>;
  createRole(
    input: CreateRoleInput,
    options?: { allowGlobalPermissions?: boolean },
  ): Promise<CatalogResult<AdminRole>>;
  updateRole(roleId: string, input: UpdateRoleInput): Promise<CatalogResult<AdminRole>>;
  replaceRolePermissions(
    roleId: string,
    permissionKeys: string[],
    options?: { allowGlobalPermissions?: boolean },
  ): Promise<CatalogResult<AdminRole>>;
  deleteRole(roleId: string): Promise<'deleted' | 'not-found' | 'in-use'>;

  /** Assigns every `isDefault` role of a client to a user, ignoring existing assignments. */
  assignDefaultRoles(input: AssignDefaultRolesInput): Promise<string[]>;
}
