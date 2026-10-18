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
  | 'expired';

export interface CreateSessionInput {
  userId: string;
  tenantId?: string;
  clientId?: string;
  loginContext?: string;
  ip?: string;
  userAgent?: string;
  amr: string[];
  acr: string;
}

export interface SessionPolicy {
  /** Sliding idle timeout in seconds. */
  idleTtlSeconds: number;
  /** Hard limit from creation in seconds. */
  absoluteTtlSeconds: number;
}
