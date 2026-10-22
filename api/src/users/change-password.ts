import { verifyPassword, type Argon2Params, DEFAULT_ARGON2_PARAMS } from '../auth/password.js';
import {
  validatePassword,
  type PasswordPolicyViolation,
  type PasswordSubject,
} from '../auth/password-policy.js';
import type { AuditEventInput } from '../audit/sanitize.js';
import type { RevokeReason } from '../session/types.js';

export interface PasswordChangeUser extends PasswordSubject {
  id: string;
  passwordHash: string | null;
  status: 'active' | 'locked' | 'disabled' | 'pending';
  deletedAt: Date | null;
}

export interface RevokeSessionOptions {
  /** Session that must stay valid (the caller's current session). */
  keepSessionId?: string;
}

export interface PasswordChangeCommit {
  userId: string;
  passwordHash: string;
  changedAt: Date;
  reason: RevokeReason;
  /** Session that keeps working (the caller's own device for a self-service change). */
  keepSessionId?: string;
}

export interface PasswordChangeCounts {
  revokedSessions: number;
  revokedRefreshTokens: number;
}

export interface PasswordStore {
  findUser(userId: string): Promise<PasswordChangeUser | null>;
  /**
   * Revokes the user's live (Redis) sessions. It runs **before** the write transaction on
   * purpose: over-revoking is recoverable, a session that outlives the password it was created
   * with is not. A rejection aborts the change before the password is written
   * (card #70 finding 3).
   */
  revokeLiveSessions(
    userId: string,
    reason: RevokeReason,
    options?: RevokeSessionOptions,
  ): Promise<void>;
  /**
   * One transaction for the three writes a password change needs: the password itself, the
   * session rows and the refresh-token rows. A partial application would leave usable refresh
   * tokens next to a new password (card #70 finding 3).
   */
  commitPasswordChange(commit: PasswordChangeCommit): Promise<PasswordChangeCounts>;
  recordAudit(event: AuditEventInput): Promise<void>;
}

export interface ChangePasswordInput {
  userId: string;
  newPassword: string;
  /** Required for self-service changes; omitted for admin reset and reset-token flows. */
  currentPassword?: string;
  /**
   * Self-service only: keep the caller's current session instead of revoking every session.
   * Other sessions and their refresh tokens are still revoked (docs/auth-flows.md 5.2).
   */
  keepSessionId?: string;
  actorType?: 'user' | 'admin' | 'system';
  actorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  params?: Argon2Params;
}

export type ChangePasswordFailure =
  'user_not_found' | 'user_disabled' | 'invalid_current_password' | 'password_reuse';

export type ChangePasswordResult =
  | { ok: true; revokedSessions: number; revokedRefreshTokens: number }
  | { ok: false; reason: ChangePasswordFailure }
  | { ok: false; reason: 'password_policy'; violations: PasswordPolicyViolation[] };

/**
 * Changes a password, revokes every session and refresh token of the user
 * (docs/domain-model.md 5) and records an audit event without any secret material.
 */
export async function changePassword(
  store: PasswordStore,
  hashPasswordFn: (password: string, params: Argon2Params) => Promise<string>,
  input: ChangePasswordInput,
  now: () => Date = () => new Date(),
): Promise<ChangePasswordResult> {
  const params = input.params ?? DEFAULT_ARGON2_PARAMS;
  const user = await store.findUser(input.userId);

  if (user === null || user.deletedAt !== null) {
    return { ok: false, reason: 'user_not_found' };
  }
  if (user.status === 'disabled') {
    return { ok: false, reason: 'user_disabled' };
  }

  if (input.currentPassword !== undefined) {
    const currentValid =
      user.passwordHash !== null &&
      (await verifyPassword(user.passwordHash, input.currentPassword, params));
    if (!currentValid) {
      await recordFailure(store, user.id, input, now());
      return { ok: false, reason: 'invalid_current_password' };
    }
  }

  const violations = validatePassword(input.newPassword, user);
  if (violations.length > 0) {
    return { ok: false, reason: 'password_policy', violations };
  }

  if (
    user.passwordHash !== null &&
    (await verifyPassword(user.passwordHash, input.newPassword, params))
  ) {
    return { ok: false, reason: 'password_reuse' };
  }

  const changedAt = now();
  const passwordHash = await hashPasswordFn(input.newPassword, params);
  const reason: RevokeReason = 'password_change';

  // Live sessions first (see `PasswordStore.revokeLiveSessions`): if this rejects, nothing was
  // written, so the password and the sessions can never disagree.
  await store.revokeLiveSessions(user.id, reason, revokeOptions(input));

  const { revokedSessions, revokedRefreshTokens } = await store.commitPasswordChange({
    userId: user.id,
    passwordHash,
    changedAt,
    reason,
    ...(input.keepSessionId === undefined ? {} : { keepSessionId: input.keepSessionId }),
  });

  await store.recordAudit({
    actorType: input.actorType ?? 'user',
    actorId: input.actorId ?? user.id,
    action: 'user.password.changed',
    targetType: 'user',
    targetId: user.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    result: 'success',
    metadata: {
      revokedSessions,
      revokedRefreshTokens,
      keptCurrentSession: input.keepSessionId !== undefined,
    },
  });

  return { ok: true, revokedSessions, revokedRefreshTokens };
}

const revokeOptions = (input: ChangePasswordInput): RevokeSessionOptions =>
  input.keepSessionId === undefined ? {} : { keepSessionId: input.keepSessionId };

async function recordFailure(
  store: PasswordStore,
  userId: string,
  input: ChangePasswordInput,
  occurredAt: Date,
): Promise<void> {
  await store.recordAudit({
    actorType: input.actorType ?? 'user',
    actorId: input.actorId ?? userId,
    action: 'user.password.change_failed',
    targetType: 'user',
    targetId: userId,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    result: 'failure',
    metadata: { at: occurredAt.toISOString() },
  });
}
