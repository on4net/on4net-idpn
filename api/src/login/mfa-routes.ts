import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { sanitizeAuditMetadata } from '../audit/sanitize.js';
import { MFA_ACR, type MfaLoginDependencies } from '../mfa/mfa-types.js';
import { MFA_CHALLENGE_MAX_ATTEMPTS, isChallengeToken } from '../mfa/challenge-store.js';
import { verifyRecoveryCode, verifyTotpFactor } from '../mfa/verify.js';
import { DEFAULT_ARGON2_PARAMS } from '../auth/password.js';
import type { RateLimiter, RateLimitPolicy } from '../http/rate-limit.js';
import { serializeSessionCookie } from '../session/cookie.js';
import type { RedisSessionStore } from '../session/store.js';
import { isAccountLocked, nextFailureState } from './lockout.js';
import type { LoginRouteOptions } from './routes.js';

export interface MfaVerifyRouteOptions {
  mfa: MfaLoginDependencies;
  users: Pick<
    LoginRouteOptions['users'],
    'registerSuccessfulLogin' | 'registerFailedAttempt'
  >;
  sessions: Pick<RedisSessionStore, 'create'>;
  persistSession: LoginRouteOptions['persistSession'];
  audit: LoginRouteOptions['audit'];
  cookie: LoginRouteOptions['cookie'];
  /** Shared limiter; the per-challenge budget alone is bypassed by opening new challenges. */
  rateLimiter?: RateLimiter;
  now?: () => Date;
}

interface VerifyBody {
  challengeToken?: string;
  code?: string;
  method?: string;
}

const CHALLENGE_INVALID_MESSAGE = 'این درخواست ورود معتبر نیست. دوباره وارد شوید.';
const CODE_INVALID_MESSAGE = 'کد واردشده معتبر نیست.';
const RATE_LIMITED_MESSAGE = 'تلاش‌های ناموفق بیش از حد بود. دوباره وارد شوید.';
const UNAVAILABLE_MESSAGE = 'ورود دومرحله‌ای در حال حاضر در دسترس نیست.';
/** Verification attempts per client address (docs/security.md T3). */
const MFA_RATE_LIMIT: RateLimitPolicy = { windowSeconds: 60, max: 20 };

/**
 * `POST /api/v1/login/mfa/verify` — completes a password login with TOTP or a recovery code.
 *
 * The challenge token is bound to the user/client/return_to issued by `POST /api/v1/login`,
 * lives for five minutes and allows five attempts. Each attempt is reserved atomically before
 * verification, so parallel guesses cannot exceed the budget, and the challenge is consumed
 * atomically, so replaying a completed challenge or reusing the same TOTP step never yields a
 * second session. Errors are deliberately generic so they cannot distinguish an expired
 * challenge from a wrong code.
 */
export function registerMfaVerifyRoute(app: FastifyInstance, options: MfaVerifyRouteOptions): void {
  const now = options.now ?? (() => new Date());

  app.post('/api/v1/login/mfa/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as VerifyBody;
    const token = typeof body.challengeToken === 'string' ? body.challengeToken.trim() : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const method = body.method === 'recovery' ? 'recovery' : 'totp';

    if (!isChallengeToken(token) || code === '' || code.length > 64) {
      return failure(reply, 400, 'invalid_request', 'request is malformed');
    }

    if (options.rateLimiter !== undefined) {
      const allowed = await options.rateLimiter.consume(`login:mfa:${request.ip}`, MFA_RATE_LIMIT);
      if (!allowed) {
        return failure(reply, 429, 'too_many_requests', RATE_LIMITED_MESSAGE);
      }
    }

    // Claim one attempt before any verification work. The reservation is atomic, so
    // concurrent requests get distinct attempt numbers and cannot share the budget the way a
    // read → verify → fail sequence allowed (docs/security.md T3).
    const reservation = await options.mfa.challenges.reserve(token);
    if (reservation.record === null) {
      return failure(reply, 401, 'mfa_challenge_invalid', CHALLENGE_INVALID_MESSAGE);
    }
    if (!reservation.allowed) {
      return failure(reply, 429, 'mfa_rate_limited', RATE_LIMITED_MESSAGE);
    }
    const challenge = reservation.record;

    const at = now();
    const user = await options.mfa.repository.findUserSecurity(challenge.userId);
    if (user === null || user.status !== 'active') {
      return failure(reply, 401, 'mfa_challenge_invalid', CHALLENGE_INVALID_MESSAGE);
    }
    // The same lockout as the password branch: a wrong second factor counts as a credential
    // failure, otherwise the MFA step would have no failure budget of its own.
    if (isAccountLocked(user.lockedUntil, at)) {
      return failure(reply, 429, 'mfa_rate_limited', RATE_LIMITED_MESSAGE);
    }
    const factor = await options.mfa.repository.findConfirmedTotp(user.id);
    if (factor === null) {
      return failure(reply, 401, 'mfa_challenge_invalid', CHALLENGE_INVALID_MESSAGE);
    }

    const proof =
      method === 'totp'
        ? await verifyTotpFactor(
            { repository: options.mfa.repository, secretBox: options.mfa.secretBox },
            factor,
            code,
            at,
          )
        : await verifyRecoveryCode(
            {
              repository: options.mfa.repository,
              verify: (hash, value) =>
                options.mfa.verify(
                  hash,
                  value,
                  options.mfa.recoveryParams ?? DEFAULT_ARGON2_PARAMS,
                ),
              at,
            },
            factor.id,
            code,
          );

    if (!proof.ok) {
      if (proof.reason === 'unavailable') {
        return failure(reply, 503, 'mfa_unavailable', UNAVAILABLE_MESSAGE);
      }
      const failureState = nextFailureState(user, at);
      await options.users.registerFailedAttempt(
        user.id,
        failureState.attempts,
        failureState.lockedUntil,
      );
      await options.audit.record({
        actorType: 'user',
        actorId: user.id,
        action: 'user.mfa.failed',
        targetType: 'user',
        targetId: user.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        result: 'failure',
        metadata: sanitizeAuditMetadata({
          method,
          reason: proof.reason,
          attempts: failureState.attempts,
          challengeAttempt: reservation.attempt,
        }),
      });
      if (failureState.locked || reservation.attempt >= MFA_CHALLENGE_MAX_ATTEMPTS) {
        // Destroy the challenge (and its counter) as the old `fail()` did, so a later request
        // sees an invalid challenge instead of a lingering exhausted one.
        await options.mfa.challenges.consume(token);
        return failure(reply, 429, 'mfa_rate_limited', RATE_LIMITED_MESSAGE);
      }
      return failure(reply, 401, 'invalid_mfa_code', CODE_INVALID_MESSAGE);
    }

    // Single-use: only one request can consume the challenge, even after a valid code.
    const consumed = await options.mfa.challenges.consume(token);
    if (consumed === null) {
      return failure(reply, 401, 'mfa_challenge_invalid', CHALLENGE_INVALID_MESSAGE);
    }

    const amr = ['pwd', method === 'recovery' ? 'recovery' : 'totp'];
    const session = await options.sessions.create({
      userId: user.id,
      tenantId: user.tenantId,
      ...(consumed.clientId === undefined ? {} : { clientId: consumed.clientId }),
      ...(consumed.loginContext === undefined ? {} : { loginContext: consumed.loginContext }),
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? '',
      amr,
      acr: MFA_ACR,
      authTime: at,
    });

    await options.persistSession({
      sid: session.sid,
      userId: user.id,
      tenantId: user.tenantId,
      ...(session.clientId === undefined ? {} : { clientId: session.clientId }),
      ...(session.loginContext === undefined ? {} : { loginContext: session.loginContext }),
      ...(session.ip === undefined ? {} : { ip: session.ip }),
      ...(session.userAgent === undefined ? {} : { userAgent: session.userAgent }),
      amr: session.amr,
      acr: session.acr,
      createdAt: new Date(session.createdAt),
      idleExpiresAt: new Date(session.idleExpiresAt),
      absoluteExpiresAt: new Date(session.absoluteExpiresAt),
    });

    await options.users.registerSuccessfulLogin(user.id, at);
    await options.audit.record({
      actorType: 'user',
      actorId: user.id,
      action: 'user.login.succeeded',
      targetType: 'user',
      targetId: user.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'success',
      metadata: sanitizeAuditMetadata({ sid: session.sid, amr, method }),
    });
    if (method === 'recovery') {
      await options.audit.record({
        actorType: 'user',
        actorId: user.id,
        action: 'user.mfa.recovery_used',
        targetType: 'user',
        targetId: user.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        result: 'success',
        metadata: { factorId: factor.id },
      });
    }

    return reply
      .code(200)
      .header('Cache-Control', 'no-store')
      .header(
        'Set-Cookie',
        serializeSessionCookie(session.sid, {
          secure: options.cookie.secure,
          maxAgeSeconds: options.cookie.absoluteTtlSeconds,
          path: '/',
        }),
      )
      .send({
        ok: true,
        ...(consumed.returnTo === undefined ? {} : { redirectTo: consumed.returnTo }),
      });
  });
}

function failure(
  reply: FastifyReply,
  status: 400 | 401 | 429 | 503,
  error: string,
  message: string,
): FastifyReply {
  return reply.code(status).header('Cache-Control', 'no-store').send({ error, message });
}
