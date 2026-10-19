import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AdminAudit } from '../admin/admin-types.js';
import type { AdminSessionRepository } from '../admin/sessions/session-types.js';
import {
  disableTotp,
  enrollTotp,
  getMfaStatus,
  regenerateRecoveryCodes,
  verifyTotpEnrollment,
  type AccountMfaDependencies,
} from './mfa.js';
import type { AccountProfile, AccountProfileRepository } from './account-types.js';
import {
  accountSessionsQuerySchema,
  changePasswordSchema,
  disableTotpSchema,
  enrollTotpSchema,
  regenerateRecoveryCodesSchema,
  renameMfaFactorSchema,
  verifyTotpEnrollmentSchema,
  verifyWebauthnAuthenticationSchema,
  verifyWebauthnRegistrationSchema,
} from './schemas.js';
import { hashPassword, type Argon2Params } from '../auth/password.js';
import { MFA_ACR } from '../mfa/mfa-types.js';
import {
  beginAuthentication,
  beginRegistration,
  deleteCredential,
  finishAuthentication,
  finishRegistration,
  renameCredential,
  type WebauthnServiceDependencies,
} from '../mfa/webauthn.js';
import { readSessionId, serializeSessionCookie } from '../session/cookie.js';
import type { IdpSession, RevokeReason } from '../session/types.js';
import { changePassword, type PasswordStore } from '../users/change-password.js';

export interface AccountRoutesOptions {
  /** Public IdP origin; mutating calls must be same-origin (CSRF defence). */
  appUrl: string;
  /** Redis session store: the cookie is the only credential accepted here. */
  sessions: {
    read(sid: string): Promise<IdpSession | null>;
    revoke(sid: string, reason: RevokeReason): Promise<boolean>;
    /** Rotates the session id and records a fresh MFA authentication (step-up). */
    stepUp?(
      sid: string,
      input: { amr: string[]; acr: string; authTime: Date },
    ): Promise<IdpSession | null>;
  };
  /** PostgreSQL session mirror, shared with the Admin API (docs/api.md 3.1). */
  repository: AdminSessionRepository;
  /** Mirrors a rotated session after step-up so tokens can reference it (FK). */
  persistSession?(input: {
    sid: string;
    userId: string;
    tenantId: string;
    clientId?: string;
    ip?: string;
    userAgent?: string;
    amr: string[];
    acr: string;
    createdAt: Date;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<void>;
  profiles: AccountProfileRepository;
  passwords: PasswordStore;
  audit: AdminAudit;
  /** MFA surface (docs/auth-flows.md 7). Omitted only when the deployment has no key. */
  mfa?: AccountMfaDependencies;
  /** WebAuthn/passkey ceremonies (docs/security.md 3.3). */
  webauthn?: WebauthnServiceDependencies;
  hash?: (password: string, params: Argon2Params) => Promise<string>;
  now?: () => Date;
}

const PROBLEM_BASE = 'https://on4net.dev/problems';

export type ProblemSlug =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid-current-password'
  | 'current-session'
  | 'password-policy'
  | 'password-reuse'
  | 'validation-error'
  | 'not-found'
  | 'conflict'
  | 'invalid-mfa-code'
  | 'invalid-token'
  | 'rate-limited'
  | 'service-unavailable';

interface ProblemExtension {
  code?: string;
  violations?: readonly string[];
  instance?: string;
}

/**
 * RFC 9457 problem response. `code` and `violations` are extension members so the MFE can
 * translate policy failures without parsing an English sentence.
 */
export function sendProblem(
  reply: FastifyReply,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503,
  slug: ProblemSlug,
  title: string,
  detail: string,
  extension: ProblemExtension = {},
): FastifyReply {
  const { instance, ...members } = extension;
  return reply
    .code(status)
    .header('Content-Type', 'application/problem+json')
    .header('Cache-Control', 'no-store')
    .send({
      type: `${PROBLEM_BASE}/${slug}`,
      title,
      status,
      detail,
      ...members,
      ...(instance === undefined ? {} : { instance }),
    });
}

const expectedOrigin = (appUrl: string): string => {
  try {
    return new URL(appUrl).origin;
  } catch {
    return appUrl;
  }
};

/**
 * Cookie-authenticated state-changing requests are only accepted from the IdP origin.
 *
 * - a present `Origin` must match exactly;
 * - without `Origin` the request must prove a same-origin browser context via
 *   `Sec-Fetch-Site`; anything else (including no headers at all) is rejected;
 * - `PUT` additionally requires `application/json`, so a cross-site HTML form (which can
 *   only send GET/POST with simple content types) can never reach the handler.
 */
export function isSameOriginRequest(request: FastifyRequest, appUrl: string): boolean {
  const origin = request.headers.origin;
  const site = request.headers['sec-fetch-site'];
  const expected = expectedOrigin(appUrl);

  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') {
    return false;
  }
  if (typeof origin === 'string' && origin !== '') {
    try {
      return new URL(origin).origin === expected;
    } catch {
      return false;
    }
  }
  return site === 'same-origin' || site === 'none';
}

export function hasJsonContentType(request: FastifyRequest): boolean {
  const header = request.headers['content-type'];
  if (typeof header !== 'string') {
    return false;
  }
  return header.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

const noStore = (reply: FastifyReply): FastifyReply => reply.header('Cache-Control', 'no-store');

const toPublicProfile = (profile: AccountProfile): AccountProfile => ({ ...profile });

/**
 * Same-origin account surface for the embedded `account` MFE (docs/account-api.md).
 *
 * Authentication is the `idpn_session` cookie read through the Redis session store, never
 * the Admin API bearer token: a normal user has no `idp:*` permission. Every query is
 * scoped to the session's `userId`, so one user can never read or close another user's
 * sessions.
 */
export function registerAccountRoutes(app: FastifyInstance, options: AccountRoutesOptions): void {
  const now = options.now ?? (() => new Date());
  const hash = options.hash ?? hashPassword;

  const authenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ session: IdpSession; profile: AccountProfile } | null> => {
    const sid = readSessionId(request.headers.cookie);
    const session = sid === null ? null : await options.sessions.read(sid);
    if (session === null) {
      sendProblem(reply, 401, 'unauthorized', 'Unauthorized', 'an active IdP session is required', {
        code: 'login_required',
      });
      return null;
    }
    const profile = await options.profiles.findById(session.userId);
    // A deleted or disabled account must not keep a usable account surface even if its
    // session has not expired yet.
    if (profile === null || profile.status === 'disabled') {
      sendProblem(
        reply,
        401,
        'unauthorized',
        'Unauthorized',
        'the account is no longer available',
        { code: 'account_unavailable' },
      );
      return null;
    }
    return { session, profile };
  };

  app.get('/api/v1/account/profile', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    return noStore(reply).send(toPublicProfile(auth.profile));
  });

  app.put('/api/v1/account/password', async (request, reply) => {
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
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        { instance: '/api/v1/account/password' },
      );
    }

    const result = await changePassword(
      options.passwords,
      hash,
      {
        userId: auth.profile.id,
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
        keepSessionId: auth.session.sid,
        actorType: 'user',
        actorId: auth.profile.id,
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      },
      now,
    );

    if (!result.ok) {
      if (result.reason === 'invalid_current_password') {
        return sendProblem(
          reply,
          400,
          'invalid-current-password',
          'Invalid current password',
          'the current password is incorrect',
          { code: 'invalid_current_password' },
        );
      }
      if (result.reason === 'password_reuse') {
        return sendProblem(
          reply,
          422,
          'password-reuse',
          'Password reuse',
          'the new password must differ from the current password',
          { code: 'password_reuse' },
        );
      }
      if (result.reason === 'password_policy') {
        return sendProblem(
          reply,
          422,
          'password-policy',
          'Password policy violated',
          'the new password does not meet the password policy',
          { code: 'password_policy', violations: result.violations },
        );
      }
      return sendProblem(
        reply,
        401,
        'unauthorized',
        'Unauthorized',
        'the account is no longer available',
        { code: 'account_unavailable' },
      );
    }

    return noStore(reply).send({
      ok: true,
      revokedSessions: result.revokedSessions,
      revokedRefreshTokens: result.revokedRefreshTokens,
      keptCurrentSession: true,
    });
  });

  app.get('/api/v1/account/sessions', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    const parsed = accountSessionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        { instance: '/api/v1/account/sessions' },
      );
    }

    const { page, limit } = parsed.data;
    const result = await options.repository.list({
      page,
      limit,
      userId: auth.profile.id,
      status: 'active',
    });
    return noStore(reply).send({
      items: result.items.map((session) => ({
        ...session,
        current: session.id === auth.session.sid,
      })),
      page,
      limit,
      total: result.total,
    });
  });

  app.delete<{ Params: { sid: string } }>(
    '/api/v1/account/sessions/:sid',
    async (request, reply) => {
      if (!isSameOriginRequest(request, options.appUrl)) {
        return sendProblem(reply, 403, 'forbidden', 'Forbidden', 'same-origin request required', {
          code: 'cross_origin_request',
        });
      }
      const auth = await authenticate(request, reply);
      if (auth === null) {
        return reply;
      }

      const session = await options.repository.findById(request.params.sid);
      // A foreign session is indistinguishable from an unknown one (docs/api.md 3.1).
      if (session === null || session.userId !== auth.profile.id) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'session does not exist');
      }
      if (session.id === auth.session.sid) {
        return sendProblem(
          reply,
          409,
          'current-session',
          'Current session',
          'the current session is closed by signing out, not from this list',
          { code: 'current_session' },
        );
      }

      await options.sessions.revoke(session.id, 'logout');
      const at = now();
      const revoked = await options.repository.revoke(session.id, at, 'user_revoked');
      const revokedRefreshTokens = await options.repository.revokeRefreshTokensForSession(
        session.id,
        at,
      );
      await options.audit.record({
        actorType: 'user',
        actorId: auth.profile.id,
        action: 'session.revoke',
        targetType: 'session',
        targetId: session.id,
        clientId: session.clientId,
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
        result: 'success',
        metadata: {
          userId: session.userId,
          reason: 'user_revoked',
          selfService: true,
          revokedRefreshTokens,
        },
      });
      return noStore(reply).send({ revoked: true, alreadyRevoked: !revoked });
    },
  );

  /** MFA mutations are cookie-authenticated, so they need the same CSRF guard as password. */
  const guardMfaMutation = (
    request: FastifyRequest,
    reply: FastifyReply,
    requireJson = true,
  ): boolean => {
    if (
      !isSameOriginRequest(request, options.appUrl) ||
      (requireJson && !hasJsonContentType(request))
    ) {
      sendProblem(
        reply,
        403,
        'forbidden',
        'Forbidden',
        requireJson ? 'same-origin JSON request required' : 'same-origin request required',
        { code: 'cross_origin_request' },
      );
      return false;
    }
    return true;
  };

  const mfaUnavailable = (reply: FastifyReply): FastifyReply =>
    sendProblem(
      reply,
      503,
      'service-unavailable',
      'MFA unavailable',
      'this deployment cannot store TOTP secrets',
      { code: 'mfa_unavailable' },
    );

  const invalidBody = (reply: FastifyReply, instance: string, detail: string): FastifyReply =>
    sendProblem(reply, 422, 'validation-error', 'Validation failed', detail, { instance });

  app.get('/api/v1/account/mfa', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    if (options.mfa === undefined) {
      return mfaUnavailable(reply);
    }
    const status = await getMfaStatus(options.mfa, auth.profile.id);
    return noStore(reply).send({
      ...status,
      available: options.mfa.secretBox !== null,
    });
  });

  app.post('/api/v1/account/mfa/totp/enroll', async (request, reply) => {
    if (!guardMfaMutation(request, reply)) {
      return reply;
    }
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    if (options.mfa === undefined) {
      return mfaUnavailable(reply);
    }
    const parsed = enrollTotpSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return invalidBody(reply, '/api/v1/account/mfa/totp/enroll', 'invalid request body');
    }

    const result = await enrollTotp(options.mfa, {
      userId: auth.profile.id,
      accountName: auth.profile.email,
      ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
    });
    if (!result.ok) {
      if (result.reason === 'unavailable') {
        return mfaUnavailable(reply);
      }
      return sendProblem(
        reply,
        409,
        'conflict',
        'TOTP already enrolled',
        'a confirmed TOTP factor already exists for this account',
        { code: 'totp_already_enrolled' },
      );
    }
    // The secret is returned exactly once and never stored in plaintext or audited.
    return noStore(reply).code(201).send({
      factorId: result.factorId,
      secret: result.secret,
      otpauthUri: result.otpauthUri,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
  });

  app.post('/api/v1/account/mfa/totp/verify', async (request, reply) => {
    if (!guardMfaMutation(request, reply)) {
      return reply;
    }
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    if (options.mfa === undefined) {
      return mfaUnavailable(reply);
    }
    const parsed = verifyTotpEnrollmentSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return invalidBody(reply, '/api/v1/account/mfa/totp/verify', 'invalid request body');
    }

    const result = await verifyTotpEnrollment(options.mfa, {
      userId: auth.profile.id,
      factorId: parsed.data.factorId,
      code: parsed.data.code,
    });
    if (result.ok) {
      return noStore(reply).send({ ok: true, recoveryCodes: result.recoveryCodes });
    }
    if (result.reason === 'not_found') {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'factor does not exist', {
        code: 'mfa_factor_not_found',
      });
    }
    if (result.reason === 'already_confirmed') {
      return sendProblem(
        reply,
        409,
        'conflict',
        'Already confirmed',
        'the factor is already confirmed',
        { code: 'totp_already_confirmed' },
      );
    }
    if (result.reason === 'unavailable') {
      return mfaUnavailable(reply);
    }
    return sendProblem(
      reply,
      400,
      'invalid-mfa-code',
      'Invalid code',
      'the verification code is not valid',
      { code: 'invalid_mfa_code' },
    );
  });

  app.post('/api/v1/account/mfa/totp/disable', async (request, reply) => {
    if (!guardMfaMutation(request, reply)) {
      return reply;
    }
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    if (options.mfa === undefined) {
      return mfaUnavailable(reply);
    }
    const parsed = disableTotpSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return invalidBody(reply, '/api/v1/account/mfa/totp/disable', 'invalid request body');
    }

    const result = await disableTotp(options.mfa, {
      userId: auth.profile.id,
      ...(parsed.data.factorId === undefined ? {} : { factorId: parsed.data.factorId }),
      ...(parsed.data.password === undefined ? {} : { password: parsed.data.password }),
      ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }),
      actorIp: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
    });
    if (result.ok) {
      return noStore(reply).send({ ok: true });
    }
    if (result.reason === 'not_found') {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'factor does not exist', {
        code: 'mfa_factor_not_found',
      });
    }
    if (result.reason === 'invalid_password') {
      return sendProblem(
        reply,
        400,
        'invalid-current-password',
        'Invalid current password',
        'the current password is incorrect',
        { code: 'invalid_current_password' },
      );
    }
    if (result.reason === 'invalid_code') {
      return sendProblem(
        reply,
        400,
        'invalid-mfa-code',
        'Invalid code',
        'the verification code is not valid',
        { code: 'invalid_mfa_code' },
      );
    }
    return sendProblem(
      reply,
      401,
      'unauthorized',
      'Unauthorized',
      'the account is no longer available',
      { code: 'account_unavailable' },
    );
  });

  app.post('/api/v1/account/mfa/recovery-codes', async (request, reply) => {
    if (!guardMfaMutation(request, reply)) {
      return reply;
    }
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    if (options.mfa === undefined) {
      return mfaUnavailable(reply);
    }
    const parsed = regenerateRecoveryCodesSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return invalidBody(reply, '/api/v1/account/mfa/recovery-codes', 'invalid request body');
    }

    const result = await regenerateRecoveryCodes(options.mfa, {
      userId: auth.profile.id,
      password: parsed.data.password,
    });
    if (result.ok) {
      return noStore(reply).send({ recoveryCodes: result.recoveryCodes });
    }
    if (result.reason === 'not_found') {
      return sendProblem(reply, 404, 'not-found', 'Not found', 'no confirmed factor exists', {
        code: 'mfa_factor_not_found',
      });
    }
    return sendProblem(
      reply,
      400,
      'invalid-current-password',
      'Invalid current password',
      'the current password is incorrect',
      { code: 'invalid_current_password' },
    );
  });

  const webauthnUnavailable = (reply: FastifyReply): FastifyReply =>
    sendProblem(
      reply,
      503,
      'service-unavailable',
      'Passkeys unavailable',
      'this deployment cannot verify WebAuthn ceremonies',
      { code: 'webauthn_unavailable' },
    );

  /**
   * Maps a ceremony failure to a problem response. The reason is exposed as a stable `code`
   * for translation; it never contains challenge, credential or signature material.
   */
  const webauthnFailure = (
    reply: FastifyReply,
    stage: 'enrollment' | 'authentication',
    reason: string,
  ): FastifyReply => {
    if (reason === 'challenge_invalid') {
      return sendProblem(
        reply,
        401,
        'invalid-token',
        'Ceremony expired',
        'the WebAuthn ceremony is unknown, expired or already used',
        { code: 'webauthn_challenge_invalid' },
      );
    }
    if (reason === 'duplicate_credential') {
      return sendProblem(
        reply,
        409,
        'conflict',
        'Credential already registered',
        'this authenticator is already registered to an account',
        { code: 'webauthn_credential_exists' },
      );
    }
    if (reason === 'origin_not_allowed' || reason === 'cross_origin') {
      return sendProblem(
        reply,
        403,
        'forbidden',
        'Origin rejected',
        'the WebAuthn ceremony did not originate from an allowed origin',
        { code: 'webauthn_origin_not_allowed' },
      );
    }
    return sendProblem(
      reply,
      400,
      'invalid-mfa-code',
      'Verification failed',
      stage === 'enrollment'
        ? 'the passkey registration could not be verified'
        : 'the passkey assertion could not be verified',
      { code: `webauthn_${reason}` },
    );
  };

  const auditWebauthnFailure = async (
    request: FastifyRequest,
    userId: string,
    stage: 'enrollment' | 'authentication',
    reason: string,
  ): Promise<void> => {
    await options.audit.record({
      actorType: 'user',
      actorId: userId,
      action: 'user.mfa.failed',
      targetType: 'user',
      targetId: userId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'failure',
      metadata: { type: 'webauthn', stage, reason },
    });
  };

  const tenantOf = (session: IdpSession): string => session.tenantId ?? '';

  app.post('/api/v1/account/mfa/webauthn/options', async (request, reply) => {
    if (!guardMfaMutation(request, reply)) {
      return reply;
    }
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    if (options.webauthn === undefined) {
      return webauthnUnavailable(reply);
    }
    const started = await beginRegistration(options.webauthn, {
      userId: auth.profile.id,
      tenantId: tenantOf(auth.session),
      userName: auth.profile.email,
      userDisplayName: auth.profile.displayName,
    });
    return noStore(reply).send({ challengeId: started.challengeId, options: started.options });
  });

  app.post('/api/v1/account/mfa/webauthn/verify', async (request, reply) => {
    if (!guardMfaMutation(request, reply)) {
      return reply;
    }
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    if (options.webauthn === undefined) {
      return webauthnUnavailable(reply);
    }
    const parsed = verifyWebauthnRegistrationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return invalidBody(reply, '/api/v1/account/mfa/webauthn/verify', 'invalid request body');
    }
    const result = await finishRegistration(options.webauthn, {
      userId: auth.profile.id,
      challengeId: parsed.data.challengeId,
      response: parsed.data.response,
      name: parsed.data.name ?? 'passkey',
    });
    if (!result.ok) {
      await auditWebauthnFailure(request, auth.profile.id, 'enrollment', result.reason);
      return webauthnFailure(reply, 'enrollment', result.reason);
    }
    await options.audit.record({
      actorType: 'user',
      actorId: auth.profile.id,
      action: 'user.mfa.enrolled',
      targetType: 'mfa_factor',
      targetId: result.factorId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'success',
      metadata: { type: 'webauthn' },
    });
    return noStore(reply)
      .code(201)
      .send({
        ok: true,
        factor: {
          id: result.factorId,
          type: 'webauthn',
          name: result.name,
          confirmed: true,
        },
      });
  });

  app.post('/api/v1/account/mfa/webauthn/authenticate/options', async (request, reply) => {
    if (!guardMfaMutation(request, reply)) {
      return reply;
    }
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    if (options.webauthn === undefined) {
      return webauthnUnavailable(reply);
    }
    const started = await beginAuthentication(options.webauthn, {
      userId: auth.profile.id,
      tenantId: tenantOf(auth.session),
      purpose: 'step_up',
    });
    if (!started.ok) {
      return sendProblem(
        reply,
        409,
        'conflict',
        'No passkey enrolled',
        'a confirmed passkey is required for step-up',
        { code: 'webauthn_not_enrolled' },
      );
    }
    return noStore(reply).send({ challengeId: started.challengeId, options: started.options });
  });

  app.post('/api/v1/account/mfa/webauthn/authenticate/verify', async (request, reply) => {
    if (!guardMfaMutation(request, reply)) {
      return reply;
    }
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    if (options.webauthn === undefined) {
      return webauthnUnavailable(reply);
    }
    const parsed = verifyWebauthnAuthenticationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return invalidBody(
        reply,
        '/api/v1/account/mfa/webauthn/authenticate/verify',
        'invalid request body',
      );
    }
    const result = await finishAuthentication(options.webauthn, {
      userId: auth.profile.id,
      challengeId: parsed.data.challengeId,
      response: parsed.data.response,
      purpose: 'step_up',
    });
    if (!result.ok) {
      await auditWebauthnFailure(request, auth.profile.id, 'authentication', result.reason);
      return webauthnFailure(reply, 'authentication', result.reason);
    }
    if (options.sessions.stepUp === undefined) {
      return webauthnUnavailable(reply);
    }
    const at = now();
    const amr = [...new Set([...auth.session.amr, 'webauthn', 'hwk'])];
    const upgraded = await options.sessions.stepUp(auth.session.sid, {
      amr,
      acr: MFA_ACR,
      authTime: at,
    });
    if (upgraded === null) {
      return sendProblem(reply, 401, 'unauthorized', 'Unauthorized', 'session is not active', {
        code: 'login_required',
      });
    }
    // The previous session id is revoked inside the store; mirror that so the Admin API does
    // not keep showing a session that can no longer authenticate.
    await options.repository.revoke(auth.session.sid, at, 'rotated');
    const tenantId =
      auth.session.tenantId ??
      (await options.mfa?.repository.findUserSecurity(auth.profile.id))?.tenantId ??
      '';
    await options.persistSession?.({
      sid: upgraded.sid,
      userId: upgraded.userId,
      tenantId,
      ...(upgraded.clientId === undefined ? {} : { clientId: upgraded.clientId }),
      ...(upgraded.ip === undefined ? {} : { ip: upgraded.ip }),
      ...(upgraded.userAgent === undefined ? {} : { userAgent: upgraded.userAgent }),
      amr: upgraded.amr,
      acr: upgraded.acr,
      createdAt: new Date(upgraded.createdAt),
      idleExpiresAt: new Date(upgraded.idleExpiresAt),
      absoluteExpiresAt: new Date(upgraded.absoluteExpiresAt),
    });
    await options.audit.record({
      actorType: 'user',
      actorId: auth.profile.id,
      action: 'user.mfa.step_up',
      targetType: 'user',
      targetId: auth.profile.id,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'success',
      metadata: { method: 'webauthn', factorId: result.factorId, sid: upgraded.sid },
    });
    const remaining = Math.max(
      0,
      Math.floor((new Date(upgraded.absoluteExpiresAt).getTime() - at.getTime()) / 1000),
    );
    return noStore(reply)
      .header(
        'Set-Cookie',
        serializeSessionCookie(upgraded.sid, {
          secure: options.appUrl.startsWith('https://'),
          maxAgeSeconds: remaining,
          path: '/',
        }),
      )
      .send({ ok: true, acr: upgraded.acr, amr: upgraded.amr });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/v1/account/mfa/webauthn/:id',
    async (request, reply) => {
      if (!guardMfaMutation(request, reply)) {
        return reply;
      }
      const auth = await authenticate(request, reply);
      if (auth === null) {
        return reply;
      }
      if (options.webauthn === undefined) {
        return webauthnUnavailable(reply);
      }
      const parsed = renameMfaFactorSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return invalidBody(reply, '/api/v1/account/mfa/webauthn/:id', 'invalid request body');
      }
      const result = await renameCredential(options.webauthn, {
        userId: auth.profile.id,
        factorId: request.params.id,
        name: parsed.data.name,
      });
      if (!result.ok) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'passkey does not exist', {
          code: 'mfa_factor_not_found',
        });
      }
      await options.audit.record({
        actorType: 'user',
        actorId: auth.profile.id,
        action: 'user.mfa.renamed',
        targetType: 'mfa_factor',
        targetId: request.params.id,
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
        result: 'success',
        metadata: { type: 'webauthn' },
      });
      return noStore(reply).send({ ok: true });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/account/mfa/webauthn/:id',
    async (request, reply) => {
      // A browser cannot send a cross-site DELETE form; the origin check is the CSRF proof.
      if (!guardMfaMutation(request, reply, false)) {
        return reply;
      }
      const auth = await authenticate(request, reply);
      if (auth === null) {
        return reply;
      }
      if (options.webauthn === undefined) {
        return webauthnUnavailable(reply);
      }
      const factor = await options.webauthn.repository.findWebauthn(
        auth.profile.id,
        request.params.id,
      );
      if (factor === null) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'passkey does not exist', {
          code: 'mfa_factor_not_found',
        });
      }
      const result = await deleteCredential(options.webauthn, {
        userId: auth.profile.id,
        factorId: request.params.id,
      });
      if (!result.ok) {
        return sendProblem(reply, 404, 'not-found', 'Not found', 'passkey does not exist', {
          code: 'mfa_factor_not_found',
        });
      }
      await options.audit.record({
        actorType: 'user',
        actorId: auth.profile.id,
        action: 'user.mfa.removed',
        targetType: 'mfa_factor',
        targetId: request.params.id,
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
        result: 'success',
        metadata: { type: 'webauthn' },
      });
      return noStore(reply).send({ ok: true });
    },
  );
}
