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

export type MemberFailure =
  | 'client-not-found'
  | 'not-found'
  | 'duplicate'
  | 'unknown-role'
  | 'cross-client-role'
  | 'invalid-attributes';

export type MemberResult<T> =
  { ok: true; value: T } | { ok: false; reason: MemberFailure; detail: string };

export interface MemberInviteOutcome {
  member: AdminMember;
  createdUser: boolean;
}

/** Persistence port for the client membership endpoints (docs/api.md 3.3.1). */
export interface AdminMemberRepository {
  list(
    clientId: string,
    query: ListMembersQuery,
  ): Promise<{ items: AdminMember[]; total: number } | null>;
  find(clientId: string, userId: string): Promise<AdminMember | null>;
  invite(clientId: string, input: InviteMemberInput): Promise<MemberResult<MemberInviteOutcome>>;
  update(
    clientId: string,
    userId: string,
    input: UpdateMemberInput,
  ): Promise<MemberResult<AdminMember>>;
  remove(clientId: string, userId: string): Promise<'deleted' | 'not-found'>;
  replaceRoles(
    clientId: string,
    userId: string,
    roleKeys: string[],
    assignedBy: string,
  ): Promise<MemberResult<AdminMember>>;
  listSessions(clientId: string, userId: string): Promise<AdminMemberSession[]>;
}
