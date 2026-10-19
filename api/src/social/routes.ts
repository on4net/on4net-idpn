import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { sanitizeAuditMetadata } from '../audit/sanitize.js';
import { maskEmail } from '../auth/normalize.js';
import type { LoginRouteOptions } from '../login/routes.js';
import { serializeSessionCookie } from '../session/cookie.js';
import {
  adapterErrorToSocialError,
  registrationAllowed,
  userCanSignIn,
  type SocialErrorCode,
} from './account-linking.js';
import type { SecretBox } from '../crypto/secret-box.js';
import {
  createSocialLoginTransaction,
  isSameOriginAuthorizeUrl,
  transactionMatches,
} from './login-request.js';
import { buildProviderAuthorizeUrl } from './provider-urls.js';
import type { SocialLoginRepository, SocialMembership, SocialUser } from './social-login-types.js';
import type { SocialTransactionStore } from './transaction-store.js';
import {
  SocialAdapterError,
  type NormalizedSocialProfile,
  type SocialProviderAdapter,
  type SocialProviderId,
} from './types.js';

/**
 * Per-app social login (`docs/auth-flows.md` 9, `docs/api.md` 2.8).
 *
 * `start` never trusts browser parameters: it consumes a server-issued `login_request`, re-reads
 * the client and its provider credential, and stores a fresh single-use transaction (state,
 * nonce, PKCE, exact callback URI, authorize URL) in Redis.
 *
 * `callback` consumes that transaction atomically, so a state can be used once and only by the
 * client/provider recorded in it. It then exchanges the code with **that client's** decrypted
 * secret, applies the account-linking rules and finally creates the same hardened IdP session
 * as password login before returning the user to `/oauth2/authorize`.
 */

const PROVIDERS: readonly SocialProviderId[] = ['google', 'facebook'];
const PROVIDER_SET = new Set<string>(PROVIDERS);
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_STATE_LENGTH = 200;
const MAX_LOGIN_REQUEST_LENGTH = 200;
const MAX_AUTHORIZATION_CODE_LENGTH = 4096;
const ACR_SOCIAL = 'urn:on4net:acr:social';
/** Social login is disabled for the administration panel (`docs/security.md` 3.4). */
const ADMIN_PANEL_SCOPE = 'idp.admin';

interface SocialAuditEvent {
  actorType: 'user' | 'anonymous';
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  /** Public client id, so `docs/security.md` audit queries can scope social events per app. */
  clientId?: string;
  ip?: string | null;
  userAgent?: string | null;
  result: 'success' | 'failure';
  metadata?: Record<string, unknown>;
}

export interface SocialLoginRouteOptions {
  issuer: string;
  /** Public origin used in the provider callback URL; defaults to the issuer. */
  callbackBaseUrl?: string;
  /** Hosted Auth UI where failures are reported; defaults to `${issuer}/login`. */
  loginUrl?: string;
  repository: SocialLoginRepository;
  transactions: SocialTransactionStore;
  /**
   * Decrypts `ClientSocialProvider.client_secret_encrypted`; the secret never leaves the server.
   * Absent only when the deployment has no `SOCIAL_SECRET_KEY` (development), in which case the
   * callback fails closed instead of exchanging a code.
   */
  secretBox?: Pick<SecretBox, 'decrypt'>;
  /** Injected adapters (#35); a provider without an adapter is treated as disabled. */
  adapters: Partial<Record<SocialProviderId, SocialProviderAdapter>>;
  sessions: Pick<LoginRouteOptions['sessions'], 'create'>;
  persistSession: LoginRouteOptions['persistSession'];
  audit: { record(event: SocialAuditEvent): Promise<void> };
  cookie: LoginRouteOptions['cookie'];
  /** Requests per window per IP + client + provider (`docs/security.md` 3.4). */
  rateLimit?: { windowSeconds: number; max: number };
  now?: () => Date;
}

interface RouteParams {
  clientId: string;
  provider: string;
}

type Query = Record<string, string | undefined>;

interface FailureContext {
  clientId: string;
  provider: SocialProviderId | null;
  returnTo?: string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export function registerSocialLoginRoutes(
  app: FastifyInstance,
  options: SocialLoginRouteOptions,
): void {
  const now = options.now ?? (() => new Date());
  const callbackBase = (options.callbackBaseUrl ?? options.issuer).replace(/\/+$/, '');
  const loginUrl = options.loginUrl ?? `${options.issuer.replace(/\/+$/, '')}/login`;
  const buckets = new Map<string, Bucket>();
  const limit = options.rateLimit ?? { windowSeconds: 60, max: 60 };

  const callbackUrlFor = (clientId: string, provider: SocialProviderId): string =>
    `${callbackBase}/oauth2/social/${encodeURIComponent(clientId)}/${provider}/callback`;

  /**
   * Records a failure without any provider detail and sends the user to the Hosted login page
   * with a public `social_*` code. The authorize URL is only included when it came from the
   * server-side transaction, never from the callback query.
   */
  const fail = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: FailureContext,
    code: SocialErrorCode,
    reason: string,
    userId?: string,
  ): Promise<FastifyReply> => {
    await options.audit.record({
      ...(userId === undefined
        ? { actorType: 'anonymous' as const }
        : { actorType: 'user' as const, actorId: userId, targetType: 'user', targetId: userId }),
      action: 'social.login.failed',
      clientId: context.clientId,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'failure',
      metadata: sanitizeAuditMetadata({
        provider: context.provider ?? 'unknown',
        reason,
        error: code,
      }),
    });

    const target = new URL(loginUrl, options.issuer);
    target.searchParams.set('client_id', context.clientId);
    if (context.provider !== null) {
      target.searchParams.set('provider', context.provider);
    }
    target.searchParams.set('error', code);
    if (context.returnTo !== undefined && context.returnTo !== '') {
      target.searchParams.set('return_to', context.returnTo);
    }
    return reply.header('Cache-Control', 'no-store').redirect(target.toString(), 302);
  };

  const rejectStart = async (
    request: FastifyRequest,
    reply: FastifyReply,
    clientId: string,
    provider: SocialProviderId | null,
    code: SocialErrorCode,
    reason: string,
  ): Promise<FastifyReply> => {
    await options.audit.record({
      actorType: 'anonymous',
      action: 'social.login.failed',
      clientId,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'failure',
      metadata: sanitizeAuditMetadata({ provider: provider ?? 'unknown', reason, error: code }),
    });
    return reply.code(400).header('Cache-Control', 'no-store').send({ error: code });
  };

  const rateLimited = (request: FastifyRequest, clientId: string, provider: string): boolean => {
    const key = `${request.ip}:${clientId}:${provider}`;
    return !consume(buckets, key, limit, now().getTime());
  };

  app.get(
    '/oauth2/social/:clientId/:provider/start',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as RouteParams;
      const clientId = params.clientId;
      const provider = parseProvider(params.provider);
      const query = request.query as Query;
      const at = now();

      if (rateLimited(request, clientId, params.provider)) {
        return tooManyRequests(reply, limit);
      }
      if (provider === null || !CLIENT_ID_PATTERN.test(clientId)) {
        return rejectStart(
          request,
          reply,
          clientId,
          provider,
          'social_provider_disabled',
          'unknown_client_or_provider',
        );
      }

      const loginRequestId = query['login_request'];
      if (
        loginRequestId === undefined ||
        loginRequestId === '' ||
        loginRequestId.length > MAX_LOGIN_REQUEST_LENGTH
      ) {
        return rejectStart(
          request,
          reply,
          clientId,
          provider,
          'social_state_invalid',
          'missing_login_request',
        );
      }
      // Single use: a login_request cannot start two flows (e.g. two providers in two tabs).
      const authorize = await options.transactions.takeAuthorizeLoginRequest(loginRequestId);
      if (authorize === null || authorize.clientId !== clientId) {
        return rejectStart(
          request,
          reply,
          clientId,
          provider,
          'social_state_invalid',
          'login_request_mismatch',
        );
      }
      if (!isSameOriginAuthorizeUrl(authorize.authorizeUrl, options.issuer)) {
        return rejectStart(
          request,
          reply,
          clientId,
          provider,
          'social_state_invalid',
          'login_request_redirect',
        );
      }

      const client = await options.repository.findClient(clientId);
      if (client === null || client.status !== 'active') {
        return rejectStart(
          request,
          reply,
          clientId,
          provider,
          'social_provider_disabled',
          'client_disabled',
        );
      }
      if (client.scopes.includes(ADMIN_PANEL_SCOPE)) {
        return rejectStart(
          request,
          reply,
          clientId,
          provider,
          'social_provider_disabled',
          'admin_client',
        );
      }
      const credentials = await options.repository.findProvider(clientId, provider);
      if (credentials === null || !credentials.enabled) {
        return rejectStart(
          request,
          reply,
          clientId,
          provider,
          'social_provider_disabled',
          'provider_disabled',
        );
      }

      const transaction = createSocialLoginTransaction({
        clientId,
        provider,
        redirectUri: callbackUrlFor(clientId, provider),
        returnTo: authorize.authorizeUrl,
        now: at,
      });
      await options.transactions.saveSocialLoginRequest(transaction);

      const location = buildProviderAuthorizeUrl({
        provider,
        clientKey: credentials.clientKey,
        redirectUri: transaction.redirectUri,
        state: transaction.state,
        nonce: transaction.nonce,
        codeChallenge: transaction.codeChallenge,
        scopes: credentials.scopes,
      });
      return reply.header('Cache-Control', 'no-store').redirect(location, 302);
    },
  );

  app.get(
    '/oauth2/social/:clientId/:provider/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as RouteParams;
      const clientId = params.clientId;
      const provider = parseProvider(params.provider);
      const query = request.query as Query;
      const at = now();

      if (rateLimited(request, clientId, params.provider)) {
        return tooManyRequests(reply, limit);
      }
      if (provider === null || !CLIENT_ID_PATTERN.test(clientId)) {
        return fail(
          request,
          reply,
          { clientId, provider },
          'social_provider_disabled',
          'unknown_client_or_provider',
        );
      }

      const state = query['state'];
      if (state === undefined || state === '' || state.length > MAX_STATE_LENGTH) {
        return fail(
          request,
          reply,
          { clientId, provider },
          'social_state_invalid',
          'missing_state',
        );
      }

      // Consume before any other check: a replayed or cross-client callback burns the state.
      const transaction = await options.transactions.takeSocialLoginRequest(state);
      if (transaction === null) {
        return fail(
          request,
          reply,
          { clientId, provider },
          'social_state_invalid',
          'state_expired_or_replayed',
        );
      }
      const context: FailureContext = {
        clientId,
        provider,
        returnTo: transaction.returnTo,
      };
      if (!transactionMatches(transaction, clientId, provider)) {
        return fail(request, reply, context, 'social_state_invalid', 'cross_client_callback');
      }

      if (query['error'] !== undefined) {
        // The user cancelled at the provider or the provider refused the app; the provider's
        // own code/description is deliberately discarded.
        return fail(request, reply, context, 'social_provider_error', 'provider_denied');
      }
      const code = query['code'];
      if (code === undefined || code === '' || code.length > MAX_AUTHORIZATION_CODE_LENGTH) {
        return fail(request, reply, context, 'social_provider_error', 'missing_code');
      }

      const client = await options.repository.findClient(clientId);
      if (client === null || client.status !== 'active') {
        return fail(request, reply, context, 'social_provider_disabled', 'client_disabled');
      }
      if (client.scopes.includes(ADMIN_PANEL_SCOPE)) {
        return fail(request, reply, context, 'social_provider_disabled', 'admin_client');
      }
      const credentials = await options.repository.findProvider(clientId, provider);
      if (credentials === null || !credentials.enabled) {
        return fail(request, reply, context, 'social_provider_disabled', 'provider_disabled');
      }

      let clientSecret: string;
      try {
        if (options.secretBox === undefined) {
          throw new Error('social secret key is not configured');
        }
        clientSecret = options.secretBox.decrypt(credentials.clientSecretEncrypted);
      } catch {
        return fail(request, reply, context, 'social_provider_error', 'secret_unavailable');
      }

      const adapter = options.adapters[provider];
      if (adapter === undefined) {
        return fail(request, reply, context, 'social_provider_disabled', 'adapter_missing');
      }

      let profile: NormalizedSocialProfile;
      try {
        profile = await adapter.exchangeAuthorizationCode({
          code,
          redirectUri: transaction.redirectUri,
          clientKey: credentials.clientKey,
          clientSecret,
          codeVerifier: transaction.codeVerifier,
          ...(transaction.nonce === null ? {} : { nonce: transaction.nonce }),
        });
      } catch (error) {
        const reason =
          error instanceof SocialAdapterError ? `adapter_${error.code}` : 'adapter_unexpected';
        const publicCode =
          error instanceof SocialAdapterError
            ? adapterErrorToSocialError(error.code)
            : 'social_provider_error';
        return fail(request, reply, context, publicCode, reason);
      }
      if (profile.provider !== provider) {
        return fail(request, reply, context, 'social_provider_error', 'provider_mismatch');
      }

      const canRegister = registrationAllowed({
        registrationPolicy: client.registrationPolicy,
        clientEmailDomains: client.allowedEmailDomains,
        providerEmailDomains: credentials.allowedEmailDomains,
        email: profile.email,
      });

      const identity = await options.repository.findIdentity(provider, profile.providerUserId);
      let user: SocialUser | null = null;
      let linkAction: 'existing' | 'linked' | 'created' = 'existing';

      if (identity !== null) {
        user = await options.repository.findUserById(identity.userId);
        if (user === null || !userCanSignIn(user)) {
          return fail(request, reply, context, 'access_denied', 'account_unavailable', user?.id);
        }
      } else {
        if (profile.email !== null) {
          const existing = await options.repository.findUserByEmail(client.tenantId, profile.email);
          if (existing !== null) {
            // `docs/auth-flows.md` 9.3: only a provider-verified email may be auto-linked.
            if (!profile.emailVerified) {
              return fail(
                request,
                reply,
                context,
                'social_email_unverified',
                'unverified_email_matches_account',
                existing.id,
              );
            }
            if (!userCanSignIn(existing)) {
              return fail(
                request,
                reply,
                context,
                'access_denied',
                'account_unavailable',
                existing.id,
              );
            }
            user = existing;
            linkAction = 'linked';
          }
        }

        if (user === null) {
          if (!canRegister) {
            return fail(request, reply, context, 'access_denied', 'registration_denied');
          }
          if (profile.email === null) {
            return fail(request, reply, context, 'social_email_unverified', 'missing_email');
          }
          const created = await options.repository.createUser({
            tenantId: client.tenantId,
            email: profile.email,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            locale: profile.locale,
            emailVerified: profile.emailVerified,
            now: at,
          });
          if (!created.created) {
            // Another callback created the account between the lookup and the insert.
            if (!profile.emailVerified) {
              return fail(
                request,
                reply,
                context,
                'social_email_unverified',
                'unverified_email_matches_account',
                created.user.id,
              );
            }
            if (!userCanSignIn(created.user)) {
              return fail(
                request,
                reply,
                context,
                'access_denied',
                'account_unavailable',
                created.user.id,
              );
            }
            linkAction = 'linked';
          } else {
            linkAction = 'created';
            await options.audit.record({
              actorType: 'user',
              actorId: created.user.id,
              action: 'user.create',
              targetType: 'user',
              targetId: created.user.id,
              clientId,
              ip: request.ip,
              userAgent: request.headers['user-agent'] ?? null,
              result: 'success',
              metadata: sanitizeAuditMetadata({
                provider,
                source: 'social',
                email: maskEmail(created.user.email),
              }),
            });
          }
          user = created.user;
        }

        const linked = await options.repository.linkIdentity({
          userId: user.id,
          provider,
          providerUserId: profile.providerUserId,
          now: at,
        });
        if (!linked.ok) {
          if (linkAction === 'created') {
            // The user created a moment ago lost the race for this identity; remove it so no
            // orphan duplicate is left behind (only possible when it has no references yet).
            await options.repository.releaseUnlinkedUser(user.id);
          }
          return fail(
            request,
            reply,
            context,
            'social_account_conflict',
            'identity_conflict',
            user.id,
          );
        }
        if (linkAction === 'linked') {
          await options.audit.record({
            actorType: 'user',
            actorId: user.id,
            action: 'account.link',
            targetType: 'user',
            targetId: user.id,
            clientId,
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            result: 'success',
            metadata: sanitizeAuditMetadata({
              provider,
              method: 'verified_email',
              email: maskEmail(profile.email ?? ''),
            }),
          });
        }
      }

      const membership = await ensureMembership({
        repository: options.repository,
        clientId: client.clientId,
        clientUuid: client.id,
        userId: user.id,
        canRegister,
        at,
      });
      if (!membership.ok) {
        return fail(request, reply, context, membership.error, membership.reason, user.id);
      }

      const session = await options.sessions.create({
        userId: user.id,
        tenantId: user.tenantId,
        clientId: client.clientId,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? '',
        amr: ['federated'],
        acr: ACR_SOCIAL,
        authTime: at,
      });

      await options.persistSession({
        sid: session.sid,
        userId: user.id,
        tenantId: user.tenantId,
        clientId: client.clientId,
        ...(session.ip === undefined ? {} : { ip: session.ip }),
        ...(session.userAgent === undefined ? {} : { userAgent: session.userAgent }),
        amr: session.amr,
        acr: session.acr,
        createdAt: new Date(session.createdAt),
        idleExpiresAt: new Date(session.idleExpiresAt),
        absoluteExpiresAt: new Date(session.absoluteExpiresAt),
      });

      await options.repository.markLogin(user.id, at);
      await options.audit.record({
        actorType: 'user',
        actorId: user.id,
        action: 'social.login.succeeded',
        targetType: 'user',
        targetId: user.id,
        clientId,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        result: 'success',
        metadata: sanitizeAuditMetadata({
          provider,
          identity: linkAction,
          membership: membership.value.status,
          membershipCreated: membership.value.created,
          sid: session.sid,
        }),
      });

      return reply
        .header('Cache-Control', 'no-store')
        .header(
          'Set-Cookie',
          serializeSessionCookie(session.sid, {
            secure: options.cookie.secure,
            maxAgeSeconds: options.cookie.absoluteTtlSeconds,
            path: '/',
          }),
        )
        .redirect(transaction.returnTo, 302);
    },
  );
}

interface EnsureMembershipInput {
  repository: SocialLoginRepository;
  /** Public client id (roles, audit). */
  clientId: string;
  /** Internal client UUID (membership FK). */
  clientUuid: string;
  userId: string;
  canRegister: boolean;
  at: Date;
}

type EnsureMembershipResult =
  | { ok: true; value: { status: SocialMembership['status']; created: boolean } }
  | { ok: false; error: SocialErrorCode; reason: string };

/**
 * Guarantees an active membership for the app without ever resurrecting a suspended one.
 * A missing membership is only created when the registration policy allows it; an existing
 * invitation is accepted by the proven provider identity.
 */
async function ensureMembership(input: EnsureMembershipInput): Promise<EnsureMembershipResult> {
  const existing = await input.repository.findMembership(input.clientUuid, input.userId);
  if (existing !== null) {
    if (existing.status === 'suspended') {
      return { ok: false, error: 'social_membership_suspended', reason: 'membership_suspended' };
    }
    if (existing.status === 'invited') {
      const activated = await input.repository.activateMembership(existing.id, input.at);
      if (activated.status === 'suspended') {
        return { ok: false, error: 'social_membership_suspended', reason: 'membership_suspended' };
      }
      return { ok: true, value: { status: activated.status, created: false } };
    }
    return { ok: true, value: { status: existing.status, created: false } };
  }

  if (!input.canRegister) {
    return { ok: false, error: 'access_denied', reason: 'registration_denied' };
  }

  const created = await input.repository.createMembership({
    clientId: input.clientUuid,
    userId: input.userId,
    joinedAt: input.at,
  });
  if (created.status === 'suspended') {
    // An admin suspended the membership concurrently; do not grant a session.
    return { ok: false, error: 'social_membership_suspended', reason: 'membership_suspended' };
  }
  await input.repository.assignDefaultRoles({
    clientId: input.clientId,
    userId: input.userId,
  });
  return { ok: true, value: { status: created.status, created: true } };
}

function parseProvider(value: string): SocialProviderId | null {
  return PROVIDER_SET.has(value) ? (value as SocialProviderId) : null;
}

function consume(
  buckets: Map<string, Bucket>,
  key: string,
  limit: { windowSeconds: number; max: number },
  nowMs: number,
): boolean {
  const bucket = buckets.get(key);
  if (bucket === undefined || bucket.resetAt <= nowMs) {
    buckets.set(key, { count: 1, resetAt: nowMs + limit.windowSeconds * 1000 });
    return true;
  }
  if (bucket.count >= limit.max) {
    return false;
  }
  bucket.count += 1;
  return true;
}

function tooManyRequests(
  reply: FastifyReply,
  limit: { windowSeconds: number; max: number },
): FastifyReply {
  return reply
    .code(429)
    .header('Retry-After', String(limit.windowSeconds))
    .header('Cache-Control', 'no-store')
    .send({ error: 'too_many_requests' });
}
