import { verifyPassword, type Argon2Params, DEFAULT_ARGON2_PARAMS } from '../auth/password.js';
import {
  validatePassword,
  type PasswordPolicyViolation,
  type PasswordSubject,
} from '../auth/password-policy.js';
import type { AuditEventInput } from '../audit/sanitize.js';

export interface PasswordChangeUser extends PasswordSubject {
  id: string;
  passwordHash: string | null;
  status: 'active' | 'locked' | 'disabled' | 'pending';
  deletedAt: Date | null;
}

export interface PasswordStore {
  findUser(userId: string): Promise<PasswordChangeUser | null>;
  updatePassword(userId: string, passwordHash: string, changedAt: Date): Promise<void>;
  revokeSessions(userId: string, revokedAt: Date, reason: string): Promise<number>;
  revokeRefreshTokens(userId: string, revokedAt: Date): Promise<number>;
  recordAudit(event: AuditEventInput): Promise<void>;
}

export interface ChangePasswordInput {
  userId: string;
  newPassword: string;
  /** Required for self-service changes; omitted for admin reset and reset-token flows. */
  currentPassword?: string;
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
  await store.updatePassword(user.id, passwordHash, changedAt);

  const revokedSessions = await store.revokeSessions(user.id, changedAt, 'password_change');
  const revokedRefreshTokens = await store.revokeRefreshTokens(user.id, changedAt);

  await store.recordAudit({
    actorType: input.actorType ?? 'user',
    actorId: input.actorId ?? user.id,
    action: 'user.password.changed',
    targetType: 'user',
    targetId: user.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    result: 'success',
    metadata: { revokedSessions, revokedRefreshTokens },
  });

  return { ok: true, revokedSessions, revokedRefreshTokens };
}

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
