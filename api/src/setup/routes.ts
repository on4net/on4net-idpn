import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { hasJsonContentType, sendProblem } from '../account/routes.js';
import { normalizeEmail, normalizeUsername } from '../auth/normalize.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePassword,
} from '../auth/password-policy.js';
import type { RateLimiter, RateLimitPolicy } from '../http/rate-limit.js';
import type { SetupStore } from './setup-types.js';
import { setupTokenMatches } from './token.js';

/** Token guesses per client address; the token itself carries 192 bits, this only bounds noise. */
export const SETUP_RATE_LIMIT: RateLimitPolicy = { windowSeconds: 15 * 60, max: 10 };

export interface SetupRoutesOptions {
  store: SetupStore;
  /** The one-time token printed at startup (or `SETUP_TOKEN`). */
  token: string;
  rateLimit: RateLimiter;
  hash: (password: string) => Promise<string>;
  /** Called once after a successful install, e.g. to drop the token from memory. */
  onInstalled?: () => void;
}

const tokenSchema = z.object({ token: z.string().min(1).max(256) }).strict();

const completeSchema = z
  .object({
    token: z.string().min(1).max(256),
    username: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[a-zA-Z0-9._-]+$/, 'letters, digits, dot, dash and underscore only'),
    email: z.string().trim().email().max(320),
    displayName: z.string().trim().min(1).max(120),
    password: z
      .string()
      .min(1)
      .max(PASSWORD_MAX_LENGTH * 2),
    adminUrl: z.string().trim().url().max(2048).optional(),
  })
  .strict();

const validationDetail = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

/** `http(s)` origin only: the value becomes the admin client's redirect URI and CORS origin. */
function adminOrigin(value: string | undefined): string | undefined | null {
  if (value === undefined || value === '') {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    if (url.username !== '' || url.password !== '') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * First-run install wizard API.
 *
 * - `GET /api/v1/setup/status` is the only call that answers after installation.
 * - `POST /api/v1/setup/verify` and `POST /api/v1/setup/complete` answer `404` once the
 *   instance is installed, exactly like a route that does not exist, and never run again.
 * - Both POSTs require the one-time setup token and are rate limited per client address.
 */
export function registerSetupRoutes(app: FastifyInstance, options: SetupRoutesOptions): void {
  // `installed` can only flip false -> true, so a true answer is cached for the process.
  let installed = false;
  const isInstalled = async (): Promise<boolean> => {
    if (!installed) {
      installed = await options.store.isInstalled();
    }
    return installed;
  };

  const closed = (reply: FastifyReply): FastifyReply =>
    sendProblem(reply, 404, 'not-found', 'Not found', 'resource not found');

  const limited = async (ip: string, reply: FastifyReply): Promise<FastifyReply | null> => {
    if (await options.rateLimit.consume(`setup:${ip}`, SETUP_RATE_LIMIT)) {
      return null;
    }
    reply.header('Retry-After', String(SETUP_RATE_LIMIT.windowSeconds));
    return sendProblem(
      reply,
      429,
      'rate-limited',
      'Too many requests',
      'too many attempts; try again later',
      { code: 'rate_limited' },
    );
  };

  const badToken = (reply: FastifyReply): FastifyReply =>
    sendProblem(reply, 403, 'forbidden', 'Forbidden', 'the setup token is not valid', {
      code: 'invalid_setup_token',
    });

  app.get('/api/v1/setup/status', async (_request, reply) => {
    return reply.header('Cache-Control', 'no-store').send({ installed: await isInstalled() });
  });

  app.post('/api/v1/setup/verify', async (request, reply) => {
    if (await isInstalled()) {
      return closed(reply);
    }
    if (!hasJsonContentType(request)) {
      return sendProblem(
        reply,
        400,
        'validation-error',
        'Bad request',
        'expected application/json',
      );
    }
    const throttled = await limited(request.ip, reply);
    if (throttled !== null) {
      return throttled;
    }
    const body = tokenSchema.safeParse(request.body);
    if (!body.success || !setupTokenMatches(options.token, body.data.token)) {
      return badToken(reply);
    }
    return reply.header('Cache-Control', 'no-store').code(204).send();
  });

  app.post('/api/v1/setup/complete', async (request, reply) => {
    if (await isInstalled()) {
      return closed(reply);
    }
    if (!hasJsonContentType(request)) {
      return sendProblem(
        reply,
        400,
        'validation-error',
        'Bad request',
        'expected application/json',
      );
    }
    const throttled = await limited(request.ip, reply);
    if (throttled !== null) {
      return throttled;
    }

    // The token is checked before anything else so an unauthenticated caller learns nothing
    // about the validation rules or the state of the instance.
    const supplied = z.object({ token: z.string().max(256) }).safeParse(request.body);
    if (!supplied.success || !setupTokenMatches(options.token, supplied.data.token)) {
      return badToken(reply);
    }

    const body = completeSchema.safeParse(request.body);
    if (!body.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        validationDetail(body.error),
      );
    }

    const email = normalizeEmail(body.data.email);
    const username = normalizeUsername(body.data.username);
    const violations = validatePassword(body.data.password, {
      email,
      username,
      displayName: body.data.displayName,
    });
    if (violations.length > 0) {
      return sendProblem(
        reply,
        422,
        'password-policy',
        'Password policy violation',
        `the password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters and not common`,
        { code: 'password_policy', violations },
      );
    }

    const origin = adminOrigin(body.data.adminUrl);
    if (origin === null) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        'adminUrl: must be an http(s) URL without credentials',
      );
    }

    const outcome = await options.store.install({
      username,
      email,
      displayName: body.data.displayName,
      passwordHash: await options.hash(body.data.password),
      ...(origin === undefined ? {} : { adminUrl: origin }),
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
    });

    if (!outcome.ok) {
      if (outcome.reason === 'already_installed') {
        installed = true;
        return closed(reply);
      }
      return sendProblem(
        reply,
        409,
        'conflict',
        'Conflict',
        'an account with this email or username already exists',
        { code: 'account_exists' },
      );
    }

    installed = true;
    options.onInstalled?.();
    return reply.header('Cache-Control', 'no-store').code(201).send({ installed: true });
  });
}
