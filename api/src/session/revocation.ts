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
  /**
   * Login-Context-scoped revocation (docs/login-contexts.md 3.4, 7.3): only sessions that
   * were created for the given context of the client are revoked. The revoked `sid`s are
   * returned so the caller can mirror exactly those rows into PostgreSQL.
   */
  revokeForUserClientContext?(
    userId: string,
    clientId: string,
    loginContext: string,
    reason: RevokeReason,
  ): Promise<string[]>;
}

export type SessionRevocationHook = (
  session: IdpSession,
  reason: RevokeReason,
) => void | Promise<void>;
