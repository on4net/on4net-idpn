export type MembershipStatus = 'invited' | 'active' | 'suspended';

export interface AdminMember {
  membershipId: string;
  userId: string;
  email: string;
  username: string;
  displayName: string;
  userStatus: 'active' | 'pending' | 'locked' | 'disabled';
  status: MembershipStatus;
  attributes: Record<string, unknown>;
  loginContextKey: string | null;
  roleKeys: string[];
  invitedAt: string | null;
  joinedAt: string | null;
  lastAccessAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminMemberSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  ip: string | null;
  userAgent: string | null;
  amr: readonly string[];
  acr: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface ListMembersQuery {
  page: number;
  limit: number;
  status?: MembershipStatus;
  query?: string;
}

export interface InviteMemberInput {
  email: string;
  displayName?: string;
  roleKeys: string[];
  attributes: Record<string, unknown>;
  invitedBy: string;
}

export interface UpdateMemberInput {
  status?: MembershipStatus;
  attributes?: Record<string, unknown>;
}

/**
 * Selects the membership scope. `loginContext` addresses one Login Context of the client;
 * omitting it keeps the client-wide (default) membership surface (docs/api.md 3.3.1/3.3.3).
 */
export interface MemberScope {
  loginContext?: string;
}

export type MemberFailure =
  | 'client-not-found'
  | 'context-not-found'
  | 'not-found'
  | 'duplicate'
  | 'unknown-role'
  | 'cross-client-role'
  /** A role is not part of the context's `allowed_roles` (docs/login-contexts.md 5). */
  | 'role-not-allowed'
  | 'invalid-attributes';

export type MemberResult<T> =
  { ok: true; value: T } | { ok: false; reason: MemberFailure; detail: string };

export interface MemberInviteOutcome {
  member: AdminMember;
  createdUser: boolean;
}

/**
 * Contexts a delegated administrator may manage inside one client: `'all'` when the admin
 * holds a client-wide membership, otherwise the active context keys. `null` = no scope.
 */
export type ContextAdminScope = 'all' | string[];

/**
 * Membership keying rule: `(client_id, login_context_id IS NULL, user_id)` for the default
 * endpoints and `(client_id, login_context_id, user_id)` for a context (docs/domain-model.md
 * 2.6.2). One user may therefore hold independent statuses and roles in each context.
 */
export interface AdminMemberRepository {
  list(
    clientId: string,
    query: ListMembersQuery,
    scope?: MemberScope,
  ): Promise<{ items: AdminMember[]; total: number } | null>;
  find(clientId: string, userId: string, scope?: MemberScope): Promise<AdminMember | null>;
  invite(
    clientId: string,
    input: InviteMemberInput,
    scope?: MemberScope,
  ): Promise<MemberResult<MemberInviteOutcome>>;
  update(
    clientId: string,
    userId: string,
    input: UpdateMemberInput,
    scope?: MemberScope,
  ): Promise<MemberResult<AdminMember>>;
  remove(clientId: string, userId: string, scope?: MemberScope): Promise<'deleted' | 'not-found'>;
  replaceRoles(
    clientId: string,
    userId: string,
    roleKeys: string[],
    assignedBy: string,
    scope?: MemberScope,
  ): Promise<MemberResult<AdminMember>>;
  listSessions(clientId: string, userId: string): Promise<AdminMemberSession[]>;
  /**
   * Resolves the contexts a delegated admin may administer server-side
   * (docs/login-contexts.md 8). Global admins never need this check.
   */
  adminContextScope(clientId: string, userId: string): Promise<ContextAdminScope | null>;
}
