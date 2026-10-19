import type { IdpSession, RevokeReason } from './types.js';

/**
 * Revocation surface shared by the session store and the Admin API.
 *
 * Revoking in Redis is what makes the very next `/oauth2/authorize` or refresh grant fail;
 * the PostgreSQL mirror is updated separately for administration and audit.
 */
export interface SessionRevoker {
  revoke(sid: string, reason: RevokeReason): Promise<boolean>;
  revokeAllForUser(userId: string, reason: RevokeReason): Promise<number>;
  /**
   * Revokes every session of the user except `keepSid`. Self-service password changes keep
   * the caller signed in while invalidating every other device (docs/auth-flows.md 5.2).
   */
  revokeAllForUserExcept?(userId: string, keepSid: string, reason: RevokeReason): Promise<number>;
}

/** App-scoped revocation used when a membership is suspended. */
export interface ClientSessionRevoker {
  /** `clientId` is the public client identifier stored on the session. */
  revokeForUserClient(userId: string, clientId: string, reason: RevokeReason): Promise<number>;
}

export type SessionRevocationHook = (
  session: IdpSession,
  reason: RevokeReason,
) => void | Promise<void>;
