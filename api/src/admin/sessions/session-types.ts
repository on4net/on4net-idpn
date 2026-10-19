/** Computed lifecycle state of an IdP session (docs/domain-model.md 2.14). */
export type AdminSessionStatus = 'active' | 'revoked' | 'expired';

export interface AdminSession {
  /** Same value as the `sid` claim. */
  id: string;
  userId: string;
  /** Public client id of the app that created the session, if any. */
  clientId: string | null;
  status: AdminSessionStatus;
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

export interface ListSessionsQuery {
  page: number;
  limit: number;
  userId?: string;
  /** Public client id (docs/api.md 3.7). */
  clientId?: string;
  status?: AdminSessionStatus;
}

/**
 * Scope forced on a delegated admin: only sessions created for that app and only for users
 * that are still members of it. `clientUuid` is the internal `clients.id`.
 */
export interface DelegatedSessionScope {
  clientUuid: string;
}

/** Persistence port for the session administration endpoints (docs/api.md 3.1, 3.7). */
export interface AdminSessionRepository {
  list(
    input: ListSessionsQuery,
    scope?: DelegatedSessionScope,
  ): Promise<{ items: AdminSession[]; total: number }>;
  findById(sid: string): Promise<AdminSession | null>;
  /** Marks the PostgreSQL mirror revoked; returns `false` when it was already revoked. */
  revoke(sid: string, revokedAt: Date, reason: string): Promise<boolean>;
  revokeAllForUser(userId: string, revokedAt: Date, reason: string): Promise<number>;
  revokeAllForUserClient(
    userId: string,
    clientUuid: string,
    revokedAt: Date,
    reason: string,
  ): Promise<number>;
  revokeRefreshTokensForUser(userId: string, revokedAt: Date): Promise<number>;
  revokeRefreshTokensForUserClient(
    userId: string,
    clientUuid: string,
    revokedAt: Date,
  ): Promise<number>;
  revokeRefreshTokensForSession(sessionId: string, revokedAt: Date): Promise<number>;
  resolveClientUuid(publicClientId: string): Promise<string | null>;
  /** Whether the user has a default-context membership in the app. */
  isMember(clientUuid: string, userId: string): Promise<boolean>;
  userExists(userId: string): Promise<boolean>;
}
