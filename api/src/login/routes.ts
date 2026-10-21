import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { sanitizeAuditMetadata } from '../audit/sanitize.js';
import { authenticateWithPassword } from '../auth/authenticate.js';
import { maskEmail } from '../auth/normalize.js';
import { hashPassword } from '../auth/password.js';
import { mfaRequirement } from '../mfa/policy.js';
import type { MfaLoginDependencies, MfaPolicy } from '../mfa/mfa-types.js';
import type { WebauthnServiceDependencies } from '../mfa/webauthn.js';
import { serializeSessionCookie } from '../session/cookie.js';
import type { RedisSessionStore } from '../session/store.js';
import type { RateLimiter, RateLimitPolicy } from '../http/rate-limit.js';
import {
  LOGIN_FAILED_CODE,
  LOGIN_FAILED_MESSAGE,
  normalizeIdentifier,
  sanitizeReturnTo,
  type LoginUserRepository,
} from './login-types.js';
import { nextFailureState } from './lockout.js';

const ACR_PASSWORD = 'urn:on4net:acr:pwd';

/**
 * Credential attempts per client address and identifier (`docs/security.md` 3.2, T1).
 * The per-account lockout alone leaves unknown identifiers unthrottled, and every attempt
 * costs a full Argon2id verification.
 */
const LOGIN_RATE_LIMIT: RateLimitPolicy = { windowSeconds: 60, max: 10 };
const LOGIN_THROTTLED_CODE = 'too_many_requests';
const LOGIN_THROTTLED_MESSAGE = 'تعداد تلاش‌ها بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید.';

export interface LoginRouteOptions {
  appUrl: string;
  users: LoginUserRepository;
  sessions: Pick<RedisSessionStore, 'create'> & Partial<Pick<RedisSessionStore, 'revoke'>>;
  /** Shared rate limiter for credential attempts; omitted only in tests. */
  rateLimiter?: RateLimiter;
  /** Mirrors the session into PostgreSQL so tokens can reference it (FK). */
  persistSession(input: {
    sid: string;
    userId: string;
    tenantId: string;
    /** Public client id; the repository resolves it to the app's UUID. */
    clientId?: string;
    /** Login Context the session was established for (omitted = client-wide). */
    loginContext?: string;
    ip?: string;
    userAgent?: string;
    amr: string[];
    acr: string;
    createdAt: Date;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<void>;
  audit: {
    record(event: {
      actorType: 'user' | 'anonymous';
      actorId?: string | null;
      action: string;
      targetType?: string;
      targetId?: string;
      ip?: string | null;
      userAgent?: string | null;
      result: 'success' | 'failure';
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
  cookie: {
    secure: boolean;
    idleTtlSeconds: number;
    absoluteTtlSeconds: number;
  };
  /** Second-factor policy and challenge storage. Without it, login stays password-only. */
  mfa?: MfaLoginDependencies;
  /** WebAuthn verification for the passkey second factor. */
  webauthn?: WebauthnServiceDependencies;
  now?: () => Date;
}

interface LoginBody {
  identifier?: string;
  password?: string;
  clientId?: string;
  loginContext?: string;
  returnTo?: string;
}

let decoyHash: string | undefined;

/**
 * `POST /api/v1/login` — credential login for the Hosted Auth UI.
 *
 * Failure responses are identical for unknown users, wrong passwords, disabled and locked
 * accounts: one message, one status, and a dummy hash verification for unknown users so the
 * response time does not reveal whether the account exists.
 */
export function registerLoginRoute(app: FastifyInstance, options: LoginRouteOptions): void {
  const now = options.now ?? (() => new Date());

  app.post('/api/v1/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as LoginBody;
    const identifier = body.identifier?.trim() ?? '';
    const password = body.password ?? '';
    /** Login context key from the hosted UI; only selects the MFA policy. */
    const loginContext = optionalLoginContext(body.loginContext);

    if (identifier === '' || password === '') {
      return reject(reply, options, request, body, undefined, 'missing_credentials');
    }

    const normalized = normalizeIdentifier(identifier);

    // Throttle before any hashing: unknown identifiers would otherwise be free to spray and
    // every attempt would cost a full Argon2id verification (docs/security.md T1, T20).
    if (options.rateLimiter !== undefined) {
      const allowed = await options.rateLimiter.consume(
        `login:${request.ip}:${normalized}`,
        LOGIN_RATE_LIMIT,
      );
      if (!allowed) {
        return reply
          .code(429)
          .header('Cache-Control', 'no-store')
          .header('Retry-After', String(LOGIN_RATE_LIMIT.windowSeconds))
          .send({ error: LOGIN_THROTTLED_CODE, message: LOGIN_THROTTLED_MESSAGE });
      }
    }

    const user = await options.users.findByIdentifier(normalized);

    if (user === null) {
      await burnPasswordVerification(password);
      return reject(reply, options, request, body, undefined, 'unknown_user');
    }

    const result = await authenticateWithPassword(user, password);
    const at = now();

    if (!result.ok) {
      if (result.reason !== 'invalid_credentials') {
        // Deleted, disabled, locked and passwordless accounts return before hashing; pay the
        // same verification cost so the response time does not reveal the account state.
        await burnPasswordVerification(password);
      }
      // A lock that already elapsed is a fresh window: the counter restarts so an attacker
      // cannot keep the account locked with a single attempt per window.
      const failure = nextFailureState(user, at);
      await options.users.registerFailedAttempt(user.id, failure.attempts, failure.lockedUntil);
      // One audit row per failure: `reject` records it with the masked identifier.
      return reject(reply, options, request, body, user.id, result.reason, maskEmail(user.email));
    }

    if (user.status !== 'active') {
      // A pending account may prove its password (to finish verification) but must never get a
      // session: every token path expects an active account (docs/security.md 3.1).
      return reject(reply, options, request, body, user.id, 'account_not_active');
    }

    const requirement = await resolveMfaRequirement(options, user, {
      ...(body.clientId === undefined ? {} : { clientId: body.clientId }),
      ...(loginContext === undefined ? {} : { loginContext }),
    });
    if (requirement.requirement === 'challenge' && options.mfa !== undefined) {
      const redirectTo = sanitizeReturnTo(body.returnTo, options.appUrl);
      const challenge = await options.mfa.challenges.create({
        userId: user.id,
        tenantId: user.tenantId,
        ...(body.clientId === undefined ? {} : { clientId: body.clientId }),
        ...(loginContext === undefined ? {} : { loginContext }),
        ...(redirectTo === undefined ? {} : { returnTo: redirectTo }),
        now: at,
      });
      await options.audit.record({
        actorType: 'user',
        actorId: user.id,
        action: 'user.login.mfa_challenged',
        targetType: 'user',
        targetId: user.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        result: 'success',
        metadata: sanitizeAuditMetadata({ methods: requirement.methods }),
      });
      // No session and no cookie until the second factor is verified (docs/auth-flows.md 7.3).
      return reply.code(200).header('Cache-Control', 'no-store').send({
        ok: false,
        mfa: 'challenge',
        challengeToken: challenge.token,
        expiresAt: challenge.record.expiresAt,
        methods: requirement.methods,
      });
    }
    if (requirement.requirement === 'enrollment_required') {
      await options.audit.record({
        actorType: 'user',
        actorId: user.id,
        action: 'user.login.mfa_enrollment_required',
        targetType: 'user',
        targetId: user.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        result: 'failure',
        metadata: sanitizeAuditMetadata({ reason: 'mfa_enrollment_required' }),
      });
      // The client/login context requires MFA for this account but no factor is enrolled.
      // No session is issued: an admin without MFA must not sign in (docs/roadmap.md phase 4).
      return reply.code(403).header('Cache-Control', 'no-store').send({
        error: 'mfa_enrollment_required',
        message: 'دومرحله‌ای برای این حساب الزامی است؛ ابتدا آن را فعال کنید.',
      });
    }

    const session = await options.sessions.create({
      userId: user.id,
      tenantId: user.tenantId,
      ...(body.clientId === undefined ? {} : { clientId: body.clientId }),
      ...(loginContext === undefined ? {} : { loginContext }),
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? '',
      amr: ['pwd'],
      acr: ACR_PASSWORD,
      authTime: at,
    });

    try {
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
    } catch (error) {
      // Without the PostgreSQL mirror no token path can reference the session, so the Redis
      // session must not survive as an unreferenced, unaudited credential.
      await options.sessions.revoke?.(session.sid, 'persist_failed').catch(() => undefined);
      throw error;
    }

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
      metadata: sanitizeAuditMetadata({ sid: session.sid }),
    });

    const redirectTo = sanitizeReturnTo(body.returnTo, options.appUrl);

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
        ...(redirectTo === undefined ? {} : { redirectTo }),
      });
  });
}

async function reject(
  reply: FastifyReply,
  options: LoginRouteOptions,
  request: FastifyRequest,
  body: LoginBody,
  userId: string | undefined,
  reason: string,
  maskedIdentifier?: string,
): Promise<FastifyReply> {
  void body;
  await options.audit.record({
    actorType: 'anonymous',
    ...(userId === undefined ? {} : { actorId: userId }),
    action: 'user.login.failed',
    targetType: 'user',
    ...(userId === undefined ? {} : { targetId: userId }),
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    result: 'failure',
    metadata: sanitizeAuditMetadata({
      reason,
      ...(maskedIdentifier === undefined ? {} : { identifier: maskedIdentifier }),
    }),
  });

  return reply
    .code(401)
    .header('Cache-Control', 'no-store')
    .send({ error: LOGIN_FAILED_CODE, message: LOGIN_FAILED_MESSAGE });
}

/**
 * Verifies a throwaway hash so every rejected attempt costs one Argon2id verification,
 * whether or not the account exists or is usable (`docs/security.md` T1, timing oracle).
 */
async function burnPasswordVerification(password: string): Promise<void> {
  decoyHash ??= await hashPassword('idp-decoy-password-value');
  await authenticateWithPassword(
    {
      id: 'decoy',
      status: 'active',
      passwordHash: decoyHash,
      lockedUntil: null,
      deletedAt: null,
    },
    password,
  );
}

/** Client-side login context keys are short slugs (`docs/login-contexts.md` 3.1). */
function optionalLoginContext(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, 64);
}

/**
 * Decides whether the session may be issued now, or whether a second factor is required.
 *
 * The policy comes from the login context (falling back to the client) and `required_admins`
 * consults the permission tables. A context with `stepUpRequired` never issues a
 * password-only session (docs/login-contexts.md 7.2, docs/security.md 3.5): MFA is required
 * even when the context's `mfaPolicy` is `optional`. A confirmed passkey counts as a factor
 * exactly like TOTP.
 */
async function resolveMfaRequirement(
  options: LoginRouteOptions,
  user: { id: string },
  input: { clientId?: string | undefined; loginContext?: string | undefined },
): Promise<{ requirement: 'none' | 'challenge' | 'enrollment_required'; methods: string[] }> {
  if (options.mfa === undefined) {
    return { requirement: 'none', methods: [] };
  }
  const policy: MfaPolicy = await options.mfa.repository.resolveMfaPolicy({
    clientId: input.clientId,
    loginContext: input.loginContext,
  });
  const stepUpRequired = await options.mfa.repository.resolveStepUpRequired({
    clientId: input.clientId,
    loginContext: input.loginContext,
  });
  const effectivePolicy: MfaPolicy = stepUpRequired ? 'required_all' : policy;
  const totp = await options.mfa.repository.findConfirmedTotp(user.id);
  const passkeys = await options.mfa.repository.listConfirmedWebauthn(user.id);
  const hasConfirmedFactor = totp !== null || passkeys.length > 0;
  const isAdmin =
    effectivePolicy === 'required_admins'
      ? await options.mfa.repository.isAdmin(user.id, input.clientId)
      : false;
  const methods = [
    ...(totp === null ? [] : ['totp', 'recovery']),
    ...(passkeys.length > 0 ? ['webauthn'] : []),
  ];
  return {
    requirement: mfaRequirement({ policy: effectivePolicy, hasConfirmedFactor, isAdmin }),
    methods,
  };
}
