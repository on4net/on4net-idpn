import type { AuditEventInput } from '../audit/sanitize.js';

export type UserStatus = 'active' | 'locked' | 'disabled' | 'pending';

/** Authenticated global-admin caller, resolved from the access token and the database. */
export interface AdminPrincipal {
  userId: string;
  clientId: string;
  scopes: readonly string[];
  permissions: ReadonlySet<string>;
}

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  phone: string | null;
  locale: string;
  status: UserStatus;
  emailVerified: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserSession {
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

export const USER_SORTS = [
  'createdAt:desc',
  'createdAt:asc',
  'lastLoginAt:desc',
  'lastLoginAt:asc',
  'email:asc',
  'email:desc',
] as const;

export type UserSort = (typeof USER_SORTS)[number];

export interface ListUsersQuery {
  page: number;
  limit: number;
  query?: string;
  status?: UserStatus;
  sort: UserSort;
}

export interface CreateUserInput {
  username: string;
  email: string;
  displayName: string;
  phone?: string | null;
  locale: string;
  status: UserStatus;
  passwordHash: string;
  mustChangePassword: boolean;
}

export interface UpdateUserInput {
  email?: string;
  displayName?: string;
  phone?: string | null;
  locale?: string;
  avatarUrl?: string | null;
}

/** Persistence port for the user administration endpoints. */
export interface AdminUserRepository {
  list(input: ListUsersQuery): Promise<{ items: AdminUser[]; total: number }>;
  findById(userId: string): Promise<AdminUser | null>;
  findIdByEmailOrUsername(email: string, username: string): Promise<string | null>;
  create(input: CreateUserInput): Promise<AdminUser>;
  update(userId: string, input: UpdateUserInput): Promise<AdminUser | null>;
  setStatus(
    userId: string,
    status: UserStatus,
    options?: { clearLock?: boolean },
  ): Promise<AdminUser | null>;
  setPassword(
    userId: string,
    passwordHash: string,
    mustChangePassword: boolean,
  ): Promise<AdminUser | null>;
  listSessions(userId: string): Promise<AdminUserSession[]>;
  revokeSessions(
    userId: string,
    options: { revokedAt: Date; reason: string; sessionId?: string },
  ): Promise<number>;
  revokeRefreshTokens(userId: string, revokedAt: Date): Promise<number>;
}

export interface AdminAudit {
  record(event: AuditEventInput): Promise<void>;
}
