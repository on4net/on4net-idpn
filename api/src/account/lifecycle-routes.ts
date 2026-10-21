import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AdminAudit } from '../admin/admin-types.js';
import { maskEmail, normalizeEmail } from '../auth/normalize.js';
import { hashPassword, verifyPassword, type Argon2Params } from '../auth/password.js';
import { validatePassword } from '../auth/password-policy.js';
import { hashOpaqueToken } from '../auth/opaque-token.js';
import type { RateLimiter, RateLimitPolicy } from '../http/rate-limit.js';
import { readSessionId } from '../session/cookie.js';
import type { IdpSession } from '../session/types.js';
import { changePassword, type PasswordStore } from '../users/change-password.js';
import type { AccountLifecycle, LifecycleUser } from './lifecycle.js';
import { accountTokenSchema, forgotPasswordSchema, setPasswordWithTokenSchema } from './schemas.js';
import {
  consumeAccountToken,
  peekAccountToken,
  type AccountTokenPurpose,
  type AccountTokenStore,
  type TokenFailure,
} from './tokens.js';
import { hasJsonContentType, isSameOriginRequest, sendProblem } from './routes.js';

/** Rate limits from docs/security.md 3.2 (email: 5/hour per account). */
export const ACCOUNT_LIFECYCLE_RATE_LIMITS = {
  passwordResetPerAccount: { windowSeconds: 3600, max: 5 },
  passwordResetPerIp: { windowSeconds: 3600, max: 20 },
  verificationPerAccount: { windowSeconds: 3600, max: 5 },
  verificationPerIp: { windowSeconds: 3600, max: 20 },
  tokenAttemptPerIp: { windowSeconds: 3600, max: 20 },
  resendPerUser: { windowSeconds: 3600, max: 5 },
} as const satisfies Record<string, RateLimitPolicy>;

/**
 * Fixed response budget for the two anti-enumeration recovery endpoints. The known-address
 * branch must not answer measurably slower than the unknown-address branch, so both answer
 * after the same minimum time regardless of how long the mail transport takes
 * (docs/security.md 4, T13).
 */
export const RECOVERY_RESPONSE_BUDGET_MS = 300;
/**
 * How long the response may wait for the mail transport before answering anyway. A fast
 * transport (including tests) keeps the accurate audit outcome; a slow one is observed in the
 * background and must never hold the response.
 */
export const RECOVERY_MAIL_OBSERVE_MS = 50;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** Recovery outcome as recorded in audit metadata. `dispatched` = still in flight at answer. */
type RecoveryOutcome = 'sent' | 'ignored' | 'mail_failed' | 'dispatched';

export interface AccountLifecycleRoutesOptions {
  appUrl: string;
  sessions: { read(sid: string): Promise<IdpSession | null> };
  lifecycle: AccountLifecycle;
  tokens: AccountTokenStore;
  passwords: PasswordStore;
  rateLimit: RateLimiter;
  audit: AdminAudit;
  hash?: (password: string, params: Argon2Params) => Promise<string>;
  now?: () => Date;
}

const validationDetail = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

const noStore = (reply: FastifyReply): FastifyReply => reply.header('Cache-Control', 'no-store');

const maskAddress = (email: string): string => maskEmail(email);

const emailKey = (email: string): string => hashOpaqueToken(normalizeEmail(email)).slice(0, 32);

/**
 * Public and session-authenticated account lifecycle endpoints:
 * invite acceptance, email verification and password reset (docs/auth-flows.md 8.2-8.4).
 *
 * Every lookup-dependent endpoint answers identically for an unknown address; audit events
 * record the internal outcome but never a token or a full email address.
 */
export function registerAccountLifecycleRoutes(
  app: FastifyInstance,
  options: AccountLifecycleRoutesOptions,
): void {
  const now = options.now ?? (() => new Date());
  const hash = options.hash ?? hashPassword;

  const audit = async (
    request: FastifyRequest,
    event: {
      action: string;
      /** Defaults to `user` when a user id is supplied (token holder who proved the mailbox). */
      actorType?: 'anonymous' | 'user';
      userId?: string | null;
      result: 'success' | 'failure';
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> => {
    const actorType = event.actorType ?? (event.userId ? 'user' : 'anonymous');
    await options.audit.record({
      actorType,
      ...(actorType === 'user' && event.userId ? { actorId: event.userId } : {}),
      action: event.action,
      targetType: event.userId === undefined || event.userId === null ? null : 'user',
      targetId: event.userId ?? null,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: event.result,
      metadata: event.metadata ?? {},
    });
  };

  const limited = async (
    reply: FastifyReply,
    key: string,
    policy: RateLimitPolicy,
  ): Promise<FastifyReply | null> => {
    if (await options.rateLimit.consume(key, policy)) {
      return null;
    }
    reply.header('Retry-After', String(policy.windowSeconds));
    return sendProblem(
      reply,
      429,
      'rate-limited',
      'Too many requests',
      'too many attempts; try again later',
      { code: 'rate_limited' },
    );
  };

  const invalidToken = (reply: FastifyReply, instance: string): FastifyReply =>
    sendProblem(
      reply,
      400,
      'invalid-token',
      'Invalid token',
      'this link is invalid or has expired',
      { code: 'invalid_token', instance },
    );

  const validation = (reply: FastifyReply, error: z.ZodError, instance: string): FastifyReply =>
    sendProblem(reply, 422, 'validation-error', 'Validation failed', validationDetail(error), {
      instance,
    });

  /** Records the reason for a failed token attempt without token material. */
  const auditTokenFailure = async (
    request: FastifyRequest,
    action: string,
    reason: TokenFailure,
    userId?: string,
  ): Promise<void> => {
    await audit(request, {
      action,
      ...(userId === undefined ? {} : { userId }),
      result: 'failure',
      metadata: { reason },
    });
  };

  /**
   * Shared confirm flow for invite acceptance and password reset: validate policy, spend the
   * token atomically, then apply the Argon2id password change (which revokes sessions).
   */
  const setPasswordWithToken = async (
    request: FastifyRequest,
    reply: FastifyReply,
    input: { token: string; password: string },
    purpose: Extract<AccountTokenPurpose, 'invite' | 'password_reset'>,
    instance: string,
  ): Promise<
    | {
        userId: string;
        user: LifecycleUser;
        revokedSessions: number;
        revokedRefreshTokens: number;
      }
    | FastifyReply
  > => {
    const at = now();
    const inspected = await peekAccountToken(options.tokens, input.token, purpose, {
      now: () => at,
    });
    if (!inspected.ok) {
      await auditTokenFailure(request, `account.${purpose}.token_failed`, inspected.reason);
      return invalidToken(reply, instance);
    }

    const user = await options.lifecycle.users.findById(inspected.userId);
    if (user === null || user.deletedAt !== null || user.status === 'disabled') {
      await auditTokenFailure(
        request,
        `account.${purpose}.token_failed`,
        'invalid',
        inspected.userId,
      );
      return invalidToken(reply, instance);
    }

    // An account that already proved its mailbox and holds a password must not be reopened
    // through a long-lived invite link (docs/auth-flows.md 8.2). The token is spent so it
    // cannot be retried later.
    if (purpose === 'invite' && user.passwordHash !== null && user.emailVerifiedAt !== null) {
      await options.tokens.invalidateActive(user.id, 'invite', at);
      await auditTokenFailure(request, 'account.invite.token_failed', 'used', user.id);
      return invalidToken(reply, instance);
    }

    // Policy failures must not burn the link: validate before the atomic consume.
    const violations = validatePassword(input.password, user);
    if (violations.length > 0) {
      return sendProblem(
        reply,
        422,
        'password-policy',
        'Password policy violated',
        'the new password does not meet the password policy',
        { code: 'password_policy', violations, instance },
      );
    }

    // Reuse is a validation failure too. Checking it here keeps the single-use link usable
    // for a corrected password instead of spending it on a change that cannot be applied.
    if (user.passwordHash !== null && (await verifyPassword(user.passwordHash, input.password))) {
      return sendProblem(
        reply,
        422,
        'password-reuse',
        'Password reuse',
        'the new password must differ from the current password',
        { code: 'password_reuse', instance },
      );
    }

    const consumed = await consumeAccountToken(options.tokens, input.token, purpose, {
      now: () => at,
    });
    if (!consumed.ok) {
      await auditTokenFailure(request, `account.${purpose}.token_failed`, consumed.reason, user.id);
      return invalidToken(reply, instance);
    }

    const changed = await changePassword(
      options.passwords,
      hash,
      {
        userId: consumed.userId,
        newPassword: input.password,
        actorType: 'user',
        actorId: consumed.userId,
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      },
      now,
    );
    if (!changed.ok) {
      if (changed.reason === 'password_policy') {
        return sendProblem(
          reply,
          422,
          'password-policy',
          'Password policy violated',
          'the new password does not meet the password policy',
          { code: 'password_policy', violations: changed.violations, instance },
        );
      }
      if (changed.reason === 'password_reuse') {
        return sendProblem(
          reply,
          422,
          'password-reuse',
          'Password reuse',
          'the new password must differ from the current password',
          { code: 'password_reuse', instance },
        );
      }
      await auditTokenFailure(request, `account.${purpose}.apply_failed`, 'invalid', user.id);
      return invalidToken(reply, instance);
    }

    return {
      userId: consumed.userId,
      user,
      revokedSessions: changed.revokedSessions,
      revokedRefreshTokens: changed.revokedRefreshTokens,
    };
  };

  /**
   * Starts a recovery mail without letting its latency reach the caller. The promise is
   * observed for a short window so a fast transport still yields the exact audit outcome;
   * `padToBudget` then makes the answer time independent of the branch.
   */
  const dispatchRecoveryMail = async (send: () => Promise<boolean>): Promise<RecoveryOutcome> =>
    Promise.race([
      send().then(
        (sent): RecoveryOutcome => (sent ? 'sent' : 'ignored'),
        (error: unknown): RecoveryOutcome => {
          // The message body contains a token; only the transport error reaches the log.
          const message = error instanceof Error ? error.message : 'unknown error';
          console.error(`account recovery mail failed: ${message}`);
          return 'mail_failed';
        },
      ),
      sleep(RECOVERY_MAIL_OBSERVE_MS).then((): RecoveryOutcome => 'dispatched'),
    ]);

  /**
   * Both recovery endpoints answer after the same minimum time, so a slow mail transport (or
   * a membership lookup) cannot tell the caller whether the address exists. A `dispatched`
   * send keeps running in the background; the audit row recorded at answer time says so
   * instead of pretending the mail already went out.
   */
  const padToBudget = async (startedAt: number): Promise<void> => {
    const remaining = RECOVERY_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
    if (remaining > 0) {
      await sleep(remaining);
    }
  };

  app.post('/api/v1/account/password/forgot', async (request, reply) => {
    const startedAt = Date.now();
    const parsed = forgotPasswordSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return validation(reply, parsed.error, '/api/v1/account/password/forgot');
    }
    const email = normalizeEmail(parsed.data.email);
    const perAccount = await limited(
      reply,
      `pwd-forgot:${emailKey(email)}`,
      ACCOUNT_LIFECYCLE_RATE_LIMITS.passwordResetPerAccount,
    );
    if (perAccount !== null) {
      return perAccount;
    }
    const perIp = await limited(
      reply,
      `pwd-forgot-ip:${request.ip}`,
      ACCOUNT_LIFECYCLE_RATE_LIMITS.passwordResetPerIp,
    );
    if (perIp !== null) {
      return perIp;
    }

    const user = await options.lifecycle.users.findByEmail(email);
    const outcome =
      user === null
        ? 'ignored'
        : await dispatchRecoveryMail(() => options.lifecycle.sendPasswordReset(user.id));
    await audit(request, {
      action: 'account.password.reset_requested',
      actorType: 'anonymous',
      ...(user === null ? {} : { userId: user.id }),
      result: outcome === 'mail_failed' ? 'failure' : 'success',
      metadata: { outcome, email: maskAddress(email) },
    });

    // Identical status, body and timing for every address (anti-enumeration).
    await padToBudget(startedAt);
    return noStore(reply).code(202).send({ status: 'accepted' });
  });

  app.post('/api/v1/account/password/reset', async (request, reply) => {
    const parsed = setPasswordWithTokenSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return validation(reply, parsed.error, '/api/v1/account/password/reset');
    }
    const rateLimited = await limited(
      reply,
      `pwd-reset-ip:${request.ip}`,
      ACCOUNT_LIFECYCLE_RATE_LIMITS.tokenAttemptPerIp,
    );
    if (rateLimited !== null) {
      return rateLimited;
    }

    const applied = await setPasswordWithToken(
      request,
      reply,
      parsed.data,
      'password_reset',
      '/api/v1/account/password/reset',
    );
    if (!('userId' in applied)) {
      return applied;
    }

    // A completed reset proves mailbox control, so any outstanding invite or verification
    // link must not be able to set another password afterwards (finding 8).
    const resetAt = now();
    const staleInvites = await options.tokens.invalidateActive(applied.userId, 'invite', resetAt);
    const staleVerifications = await options.tokens.invalidateActive(
      applied.userId,
      'email_verification',
      resetAt,
    );

    await audit(request, {
      action: 'account.password.reset',
      userId: applied.userId,
      result: 'success',
      metadata: {
        revokedSessions: applied.revokedSessions,
        revokedRefreshTokens: applied.revokedRefreshTokens,
        invalidatedTokens: staleInvites + staleVerifications,
      },
    });
    try {
      await options.lifecycle.sendPasswordChanged(applied.userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`password changed notice failed: ${message}`);
    }

    return noStore(reply).send({ ok: true });
  });

  app.post('/api/v1/account/invite/accept', async (request, reply) => {
    const parsed = setPasswordWithTokenSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return validation(reply, parsed.error, '/api/v1/account/invite/accept');
    }
    const rateLimited = await limited(
      reply,
      `invite-accept-ip:${request.ip}`,
      ACCOUNT_LIFECYCLE_RATE_LIMITS.tokenAttemptPerIp,
    );
    if (rateLimited !== null) {
      return rateLimited;
    }

    const applied = await setPasswordWithToken(
      request,
      reply,
      parsed.data,
      'invite',
      '/api/v1/account/invite/accept',
    );
    if (!('userId' in applied)) {
      return applied;
    }

    const at = now();
    await options.lifecycle.users.markEmailVerified(applied.userId, at);
    await options.lifecycle.users.activatePendingUser(applied.userId, at);
    const memberships = await options.lifecycle.users.activateInvitedMemberships(
      applied.userId,
      at,
    );
    await audit(request, {
      action: 'account.invite.accepted',
      userId: applied.userId,
      result: 'success',
      metadata: { activatedMemberships: memberships },
    });
    return noStore(reply).send({ ok: true, emailVerified: true });
  });

  app.post('/api/v1/account/email/verify', async (request, reply) => {
    const parsed = accountTokenSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return validation(reply, parsed.error, '/api/v1/account/email/verify');
    }
    const rateLimited = await limited(
      reply,
      `email-verify-ip:${request.ip}`,
      ACCOUNT_LIFECYCLE_RATE_LIMITS.tokenAttemptPerIp,
    );
    if (rateLimited !== null) {
      return rateLimited;
    }

    const at = now();
    const consumed = await consumeAccountToken(
      options.tokens,
      parsed.data.token,
      'email_verification',
      { now: () => at },
    );
    if (!consumed.ok) {
      await auditTokenFailure(request, 'account.email.verify_failed', consumed.reason);
      return invalidToken(reply, '/api/v1/account/email/verify');
    }

    await options.lifecycle.users.markEmailVerified(consumed.userId, at);
    await audit(request, {
      action: 'account.email.verified',
      userId: consumed.userId,
      result: 'success',
    });
    return noStore(reply).send({ ok: true, emailVerified: true });
  });

  app.post('/api/v1/account/email/verification/request', async (request, reply) => {
    const startedAt = Date.now();
    const parsed = forgotPasswordSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return validation(reply, parsed.error, '/api/v1/account/email/verification/request');
    }
    const email = normalizeEmail(parsed.data.email);
    const perAccount = await limited(
      reply,
      `email-verify-request:${emailKey(email)}`,
      ACCOUNT_LIFECYCLE_RATE_LIMITS.verificationPerAccount,
    );
    if (perAccount !== null) {
      return perAccount;
    }
    const perIp = await limited(
      reply,
      `email-verify-request-ip:${request.ip}`,
      ACCOUNT_LIFECYCLE_RATE_LIMITS.verificationPerIp,
    );
    if (perIp !== null) {
      return perIp;
    }

    const user = await options.lifecycle.users.findByEmail(email);
    const outcome =
      user === null
        ? 'ignored'
        : await dispatchRecoveryMail(() => options.lifecycle.sendVerification(user.id));
    await audit(request, {
      action: 'account.email.verification_requested',
      actorType: 'anonymous',
      ...(user === null ? {} : { userId: user.id }),
      result: outcome === 'mail_failed' ? 'failure' : 'success',
      metadata: { outcome, email: maskAddress(email) },
    });
    await padToBudget(startedAt);
    return noStore(reply).code(202).send({ status: 'accepted' });
  });

  app.post('/api/v1/account/email/verification', async (request, reply) => {
    if (!isSameOriginRequest(request, options.appUrl) || !hasJsonContentType(request)) {
      return sendProblem(
        reply,
        403,
        'forbidden',
        'Forbidden',
        'same-origin JSON request required',
        { code: 'cross_origin_request' },
      );
    }
    const sid = readSessionId(request.headers.cookie);
    const session = sid === null ? null : await options.sessions.read(sid);
    if (session === null) {
      return sendProblem(
        reply,
        401,
        'unauthorized',
        'Unauthorized',
        'an active IdP session is required',
        { code: 'login_required' },
      );
    }
    const user = await options.lifecycle.users.findById(session.userId);
    if (user === null || user.deletedAt !== null || user.status === 'disabled') {
      return sendProblem(
        reply,
        401,
        'unauthorized',
        'Unauthorized',
        'the account is no longer available',
        { code: 'account_unavailable' },
      );
    }

    const rateLimited = await limited(
      reply,
      `email-verify-resend:${user.id}`,
      ACCOUNT_LIFECYCLE_RATE_LIMITS.resendPerUser,
    );
    if (rateLimited !== null) {
      return rateLimited;
    }

    if (user.emailVerifiedAt !== null) {
      return noStore(reply).send({ status: 'already_verified' });
    }
    try {
      await options.lifecycle.sendVerification(user.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`verification resend failed: ${message}`);
      return sendProblem(
        reply,
        503,
        'service-unavailable',
        'Service unavailable',
        'verification mail could not be sent',
        { code: 'mail_unavailable' },
      );
    }
    await audit(request, {
      action: 'account.email.verification_requested',
      userId: user.id,
      result: 'success',
      metadata: { outcome: 'sent', email: maskAddress(user.email) },
    });
    return noStore(reply).code(202).send({ status: 'accepted' });
  });
}
