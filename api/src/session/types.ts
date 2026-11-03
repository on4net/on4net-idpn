/** Authentication context of an IdP session (docs/domain-model.md 2.14). */
export interface IdpSession {
  /** `sid` claim in ID/Access tokens. */
  sid: string;
  userId: string;
  tenantId?: string;
  /** Last client that created the session. */
  clientId?: string;
  loginContext?: string;
  createdAt: string;
  lastSeenAt: string;
  /** When the user actually authenticated; `max_age` is measured from here. */
  authTime: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  ip?: string;
  userAgent?: string;
  amr: string[];
  acr: string;
  revokedAt?: string;
  revokeReason?: RevokeReason;
}

export type RevokeReason =
  | 'logout'
  | 'global_logout'
  | 'admin'
  | 'reuse_detected'
  | 'password_change'
  | 'rotated'
  | 'expired'
  | 'concurrent_limit'
  /** The session was created but its PostgreSQL mirror failed; it must not survive. */
  | 'persist_failed';

export interface CreateSessionInput {
  userId: string;
  tenantId?: string;
  clientId?: string;
  loginContext?: string;
  ip?: string;
  userAgent?: string;
  amr: string[];
  acr: string;
  /** Authentication time; defaults to now. Preserved across rotation. */
  authTime?: Date;
  /**
   * Absolute expiry to carry over when a session is rotated: the hard limit counts from the
   * original authentication, so rotating must not restart it (card #70 finding 14).
   */
  absoluteExpiresAt?: Date;
}

export interface SessionPolicy {
  /** Sliding idle timeout in seconds. */
  idleTtlSeconds: number;
  /** Hard limit from creation in seconds. */
  absoluteTtlSeconds: number;
  /**
   * Maximum active sessions per user (`0`/undefined = unlimited). The oldest sessions beyond
   * the limit are revoked whenever a new session is created.
   */
  maxConcurrentSessions?: number;
}
