import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { sanitizeAuditMetadata } from '../audit/sanitize.js';
import { MFA_ACR, type MfaLoginDependencies } from '../mfa/mfa-types.js';
import { MFA_CHALLENGE_MAX_ATTEMPTS, isChallengeToken } from '../mfa/challenge-store.js';
import { beginAuthentication, finishAuthentication } from '../mfa/webauthn.js';
import type { RateLimiter } from '../http/rate-limit.js';
import { serializeSessionCookie } from '../session/cookie.js';
import type { RedisSessionStore } from '../session/store.js';
import { isAccountLocked, nextFailureState } from './lockout.js';
import type { LoginRouteOptions } from './routes.js';

export interface LoginWebauthnRouteOptions {
  mfa: MfaLoginDependencies;
  webauthn: NonNullable<LoginRouteOptions['webauthn']>;
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

interface OptionsBody {
  challengeToken?: unknown;
  challengeId?: unknown;
  response?: unknown;
}

const CHALLENGE_INVALID_MESSAGE = 'این درخواست ورود معتبر نیست. دوباره وارد شوید.';
const VERIFY_FAILED_MESSAGE = 'تأیید Passkey انجام نشد. دوباره تلاش کنید.';
const RATE_LIMITED_MESSAGE = 'تلاش‌های ناموفق بیش از حد بود. دوباره وارد شوید.';

/**
 * Passkey second factor of the password login (`docs/auth-flows.md` 7.3).
 *
 * `options` starts a WebAuthn ceremony bound to the pending MFA challenge; `verify`
 * completes it and consumes the MFA challenge atomically. The resulting session carries
 * `amr = [pwd, webauthn, hwk]` and `acr = urn:on4net:acr:mfa`, so the Admin API step-up
 * guard accepts it exactly like a TOTP-verified session. Passwordless first-factor login is
 * deliberately not offered: the documented MFA model is password + second factor.
 */
export function registerLoginWebauthnRoutes(
  app: FastifyInstance,
  options: LoginWebauthnRouteOptions,
): void {
  const now = options.now ?? (() => new Date());

  app.post(
    '/api/v1/login/mfa/webauthn/options',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body ?? {}) as OptionsBody;
      const token = typeof body.challengeToken === 'string' ? body.challengeToken.trim() : '';
      if (!isChallengeToken(token)) {
        return failure(reply, 400, 'invalid_request', CHALLENGE_INVALID_MESSAGE);
      }
      const challenge = await options.mfa.challenges.read(token);
      if (challenge === null) {
        return failure(reply, 401, 'mfa_challenge_invalid', CHALLENGE_INVALID_MESSAGE);
      }
      const user = await options.mfa.repository.findUserSecurity(challenge.userId);
      if (user === null || user.status !== 'active') {
        return failure(reply, 401, 'mfa_challenge_invalid', CHALLENGE_INVALID_MESSAGE);
      }
      const started = await beginAuthentication(options.webauthn, {
        userId: user.id,
        tenantId: user.tenantId,
        purpose: 'login',
        mfaChallengeToken: token,
      });
      if (!started.ok) {
        return failure(reply, 400, 'webauthn_not_enrolled', VERIFY_FAILED_MESSAGE);
      }
      return reply
        .code(200)
        .header('Cache-Control', 'no-store')
        .send({ challengeId: started.challengeId, options: started.options });
    },
  );

  app.post(
    '/api/v1/login/mfa/webauthn/verify',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body ?? {}) as OptionsBody;
      const token = typeof body.challengeToken === 'string' ? body.challengeToken.trim() : '';
      const challengeId = typeof body.challengeId === 'string' ? body.challengeId.trim() : '';
      const response = body.response;
      if (
        !isChallengeToken(token) ||
        challengeId.length < 20 ||
        challengeId.length > 128 ||
        response === null ||
        typeof response !== 'object'
      ) {
        return failure(reply, 400, 'invalid_request', VERIFY_FAILED_MESSAGE);
      }

      if (options.rateLimiter !== undefined) {
        const allowed = await options.rateLimiter.consume(
          `login:mfa:${request.ip}`,
          { windowSeconds: 60, max: 20 },
        );
        if (!allowed) {
          return failure(reply, 429, 'too_many_requests', RATE_LIMITED_MESSAGE);
        }
      }

      // Claim the attempt before the ceremony: the reservation is atomic, so concurrent
      // assertions each get a distinct attempt number instead of sharing one budget.
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
      if (isAccountLocked(user.lockedUntil, at)) {
        return failure(reply, 429, 'mfa_rate_limited', RATE_LIMITED_MESSAGE);
      }

      const result = await finishAuthentication(options.webauthn, {
        userId: user.id,
        challengeId,
        response,
        purpose: 'login',
        mfaChallengeToken: token,
      });
      if (!result.ok) {
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
            method: 'webauthn',
            reason: result.reason,
            attempts: failureState.attempts,
            challengeAttempt: reservation.attempt,
          }),
        });
        if (failureState.locked || reservation.attempt >= MFA_CHALLENGE_MAX_ATTEMPTS) {
          // Destroy the challenge and its counter, matching the TOTP route.
          await options.mfa.challenges.consume(token);
          return failure(reply, 429, 'mfa_rate_limited', RATE_LIMITED_MESSAGE);
        }
        if (result.reason === 'mfa_challenge_mismatch' || result.reason === 'challenge_invalid') {
          return failure(reply, 401, 'mfa_challenge_invalid', CHALLENGE_INVALID_MESSAGE);
        }
        return failure(reply, 401, 'invalid_mfa_code', VERIFY_FAILED_MESSAGE);
      }

      // Single-use: only one request can complete this login, even with a valid assertion.
      const consumed = await options.mfa.challenges.consume(token);
      if (consumed === null) {
        return failure(reply, 401, 'mfa_challenge_invalid', CHALLENGE_INVALID_MESSAGE);
      }

      const amr = ['pwd', 'webauthn', 'hwk'];
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
        metadata: sanitizeAuditMetadata({ sid: session.sid, amr, method: 'webauthn' }),
      });

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
    },
  );
}

function failure(
  reply: FastifyReply,
  status: 400 | 401 | 429 | 503,
  error: string,
  message: string,
): FastifyReply {
  return reply.code(status).header('Cache-Control', 'no-store').send({ error, message });
}
