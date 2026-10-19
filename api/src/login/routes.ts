import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { sanitizeAuditMetadata } from '../audit/sanitize.js';
import { authenticateWithPassword } from '../auth/authenticate.js';
import { maskEmail } from '../auth/normalize.js';
import { hashPassword } from '../auth/password.js';
import { serializeSessionCookie } from '../session/cookie.js';
import type { RedisSessionStore } from '../session/store.js';
import {
  LOGIN_FAILED_CODE,
  LOGIN_FAILED_MESSAGE,
  normalizeIdentifier,
  sanitizeReturnTo,
  type LoginUserRepository,
} from './login-types.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const ACR_PASSWORD = 'urn:on4net:acr:pwd';

export interface LoginRouteOptions {
  appUrl: string;
  users: LoginUserRepository;
  sessions: Pick<RedisSessionStore, 'create'>;
  /** Mirrors the session into PostgreSQL so tokens can reference it (FK). */
  persistSession(input: {
    sid: string;
    userId: string;
    tenantId: string;
    /** Public client id; the repository resolves it to the app's UUID. */
    clientId?: string;
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
  now?: () => Date;
}

interface LoginBody {
  identifier?: string;
  password?: string;
  clientId?: string;
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

    if (identifier === '' || password === '') {
      return reject(reply, options, request, body, undefined, 'missing_credentials');
    }

    const normalized = normalizeIdentifier(identifier);
    const user = await options.users.findByIdentifier(normalized);

    if (user === null) {
      // Constant-ish work for unknown identifiers: verify against a throwaway hash.
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
      return reject(reply, options, request, body, undefined, 'unknown_user');
    }

    const result = await authenticateWithPassword(user, password);
    const at = now();

    if (!result.ok) {
      const attempts = user.failedLoginCount + 1;
      const lockedUntil =
        attempts >= MAX_FAILED_ATTEMPTS ? new Date(at.getTime() + LOCK_DURATION_MS) : null;
      await options.users.registerFailedAttempt(user.id, attempts, lockedUntil);
      await options.audit.record({
        actorType: 'anonymous',
        action: 'user.login.failed',
        targetType: 'user',
        targetId: user.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        result: 'failure',
        metadata: sanitizeAuditMetadata({
          reason: result.reason,
          identifier: maskEmail(user.email),
        }),
      });
      return reject(reply, options, request, body, user.id, result.reason);
    }

    const session = await options.sessions.create({
      userId: user.id,
      tenantId: user.tenantId,
      ...(body.clientId === undefined ? {} : { clientId: body.clientId }),
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? '',
      amr: ['pwd'],
      acr: ACR_PASSWORD,
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
    metadata: sanitizeAuditMetadata({ reason }),
  });

  return reply
    .code(401)
    .header('Cache-Control', 'no-store')
    .send({ error: LOGIN_FAILED_CODE, message: LOGIN_FAILED_MESSAGE });
}
