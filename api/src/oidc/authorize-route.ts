import type { FastifyInstance, FastifyReply } from 'fastify';

import { MFA_ACR } from '../mfa/mfa-types.js';
import { sessionProvesMultiFactor } from '../mfa/policy.js';
import { readSessionId } from '../session/cookie.js';
import type { IdpSession } from '../session/types.js';
import {
  AUTHORIZATION_CODE_TTL_SECONDS,
  issueAuthorizationCode,
  type AuthorizationCodeRepository,
} from './authorization-code.js';
import {
  validateAuthorizeRequest,
  type AuthorizeQuery,
  type ValidatedAuthorizeRequest,
} from './authorize-request.js';
import type { ClientRepository } from './client-repository.js';
import { buildCodeRedirect, buildErrorRedirect, oauthError } from './oauth-error.js';

export interface SessionReader {
  read(sid: string): Promise<IdpSession | null>;
  /**
   * Records the Login Context the session now acts in (`docs/login-contexts.md` 3.4). When a
   * session switches context the new context is stored so listings, revocation scoping and
   * the next switch all see the same value.
   */
  rebindContext?(sid: string, loginContext: string): Promise<IdpSession | null>;
}

/**
 * Issues the opaque `login_request` handle that binds the Hosted UI (and the social start
 * endpoint) to this validated authorize request (`docs/api.md` 2.8).
 */
export interface AuthorizeLoginRequestIssuer {
  create(input: { clientId: string; authorizeUrl: string }): Promise<string>;
}

/** Membership status of a user for one client/login context (`docs/domain-model.md` 2.6.2). */
export type AuthorizeMembershipStatus = 'active' | 'invited' | 'suspended';

/** Authentication strength an authorize request needs before a code may be issued. */
export interface AuthorizeAuthenticationRequirement {
  /** The client or login-context MFA policy requires a second factor. */
  mfaRequired: boolean;
  /** A step-up context requires authentication fresher than the step-up window. */
  freshAuthenticationRequired: boolean;
}

export interface AuthorizeSubjectInput {
  userId: string;
  clientId: string;
  loginContext?: string;
}

/**
 * Window in which a step-up context accepts an existing authentication instead of forcing
 * a fresh one (`docs/login-contexts.md` 7.2: a step-up context issues no token without a
 * fresh authentication).
 */
export const STEP_UP_MAX_AGE_SECONDS = 300;

export interface AuthorizeRouteOptions {
  issuer: string;
  clients: ClientRepository;
  codes: AuthorizationCodeRepository;
  sessions: SessionReader;
  /** Consent gate; trusted first-party clients can always return `true`. */
  isConsentGranted?: (userId: string, clientId: string, scopes: string[]) => Promise<boolean>;
  /**
   * Whether the user may receive the `idp.client-admin` scope for this client. The scope is
   * only issued to users that hold at least one `idp:client-*` permission for the app
   * (docs/api.md 3).
   */
  isClientAdminEligible?: (userId: string, clientId: string) => Promise<boolean>;
  /** Hosted login URL for interactive requests (Hosted UI arrives in a later card). */
  loginUrl?: string;
  consentUrl?: string;
  /**
   * Server-side MFA/step-up policy lookup. The password login endpoint cannot be trusted to
   * enforce this: its `clientId` is caller-supplied, so a code must not be issued from a
   * password-only session for a client or context that requires a second factor
   * (`docs/login-contexts.md` 6, docs/security.md T31).
   */
  authenticationRequirement?: (
    input: AuthorizeSubjectInput,
  ) => Promise<AuthorizeAuthenticationRequirement>;
  /**
   * Membership lookup for the client (and login context, when requested). Returns `null`
   * when the user holds no membership for that exact scope (`docs/login-contexts.md` 4.1).
   */
  membershipStatus?: (input: AuthorizeSubjectInput) => Promise<AuthorizeMembershipStatus | null>;
  /** When present, the login redirect carries a single-use `login_request` handle. */
  loginRequests?: AuthorizeLoginRequestIssuer;
  /**
   * Audit hook for a context switch: an existing session obtaining a code for another
   * context of the same app (`docs/login-contexts.md` 6, 8).
   */
  audit?: {
    record(event: {
      actorType: 'user' | 'admin';
      actorId: string;
      action: string;
      targetType: string;
      targetId: string;
      clientId: string | null;
      ip?: string | null;
      userAgent?: string | null;
      result: 'success' | 'failure';
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
  /** Mirrors the new context into the PostgreSQL session row used by the Admin API. */
  persistContextSwitch?: (sid: string, loginContext: string) => Promise<void>;
  now?: () => Date;
}

type Query = Record<string, string | undefined>;

const CLIENT_ADMIN_SCOPE = 'idp.client-admin';

const asQuery = (query: Query): AuthorizeQuery => ({
  response_type: query['response_type'],
  client_id: query['client_id'],
  redirect_uri: query['redirect_uri'],
  scope: query['scope'],
  state: query['state'],
  nonce: query['nonce'],
  code_challenge: query['code_challenge'],
  code_challenge_method: query['code_challenge_method'],
  prompt: query['prompt'],
  max_age: query['max_age'],
  login_hint: query['login_hint'],
  acr_values: query['acr_values'],
  ui_locales: query['ui_locales'],
  login_context: query['login_context'],
  tenant: query['tenant'],
});

function redirect(reply: FastifyReply, location: string): FastifyReply {
  return reply.header('Cache-Control', 'no-store').redirect(location, 302);
}

/**
 * Builds the hosted-login URL for an interactive request.
 *
 * The login page needs the client and the original authorize request back so that it can
 * return the user agent to this endpoint after a successful authentication (`return_to`).
 */
export function buildLoginRedirect(
  loginUrl: string,
  authorize: ValidatedAuthorizeRequest,
  requestUrl: string,
  loginRequest?: string,
): string {
  const target = new URL(loginUrl, 'http://placeholder.invalid');
  target.searchParams.set('client_id', authorize.client.clientId);
  target.searchParams.set('return_to', requestUrl);
  if (loginRequest !== undefined) {
    target.searchParams.set('login_request', loginRequest);
  }
  if (authorize.uiLocales !== undefined) {
    target.searchParams.set('ui_locales', authorize.uiLocales);
  }
  if (authorize.loginHint !== undefined) {
    target.searchParams.set('login_hint', authorize.loginHint);
  }
  // The login page applies the context's `login_methods`: a provider that the selected
  // context does not allow gets no button (`docs/login-contexts.md` 9). The context was
  // already validated against the client above, so it is passed through verbatim.
  if (authorize.loginContext !== undefined) {
    target.searchParams.set('login_context', authorize.loginContext);
  }
  return isAbsoluteUrl(loginUrl) ? target.toString() : `${target.pathname}${target.search}`;
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/**
 * `GET /oauth2/authorize` — Authorization Code flow with mandatory PKCE (docs/auth-flows.md 2).
 *
 * Consent and the interactive login screen are separate surfaces: this handler either issues
 * a code from an existing IdP session or redirects the user agent to the login/consent page.
 */
export function registerAuthorizeRoute(app: FastifyInstance, options: AuthorizeRouteOptions): void {
  const now = options.now ?? (() => new Date());
  const loginUrl = options.loginUrl ?? `${options.issuer.replace(/\/+$/, '')}/login`;
  const consentUrl = options.consentUrl ?? `${options.issuer.replace(/\/+$/, '')}/consent`;
  const isConsentGranted = options.isConsentGranted ?? (async () => true);

  app.get('/oauth2/authorize', async (request, reply) => {
    const query = asQuery(request.query as Query);
    const client =
      query.client_id === undefined ? null : await options.clients.findByClientId(query.client_id);
    const validation = validateAuthorizeRequest(query, client);

    if (!validation.ok) {
      if (validation.redirectUri === undefined) {
        return reply.code(400).send(validation.error);
      }
      return redirect(
        reply,
        buildErrorRedirect(validation.redirectUri, validation.error, validation.state),
      );
    }

    const authorize = validation.request;
    const returnTo = request.url;
    const sid = readSessionId(request.headers.cookie);
    const session = sid === null ? null : await options.sessions.read(sid);
    const wantsSilent = authorize.prompt.includes('none');

    // `prompt=login` (docs/auth-flows.md 2.1) and a missing session both demand an
    // interactive authentication: an existing session must not be silently reused, which is
    // also what makes an explicit context switch auditable rather than invisible.
    /**
     * Sends the user agent to the login page with the validated request preserved. The social
     * flow must never trust browser parameters, so the request is kept server-side under an
     * opaque handle.
     */
    const redirectToLogin = async (): Promise<FastifyReply> => {
      const loginRequest =
        options.loginRequests === undefined
          ? undefined
          : await options.loginRequests.create({
              clientId: authorize.client.clientId,
              authorizeUrl: new URL(returnTo, options.issuer).toString(),
            });
      return redirect(reply, buildLoginRedirect(loginUrl, authorize, returnTo, loginRequest));
    };

    if (session === null || authorize.prompt.includes('login')) {
      if (wantsSilent) {
        return redirect(
          reply,
          buildErrorRedirect(authorize.redirectUri, oauthError('login_required'), authorize.state),
        );
      }
      return redirectToLogin();
    }

    if (
      authorize.maxAge !== undefined &&
      isAuthenticationTooOld(session, authorize.maxAge, now())
    ) {
      if (wantsSilent) {
        return redirect(
          reply,
          buildErrorRedirect(
            authorize.redirectUri,
            oauthError('login_required', 're-authentication required'),
            authorize.state,
          ),
        );
      }
      // `interaction_required` is reserved for `prompt=none`: an interactive client is sent
      // through authentication again so the existing session is not reused (RFC 9101/OIDC).
      return redirectToLogin();
    }

    const subject: AuthorizeSubjectInput = {
      userId: session.userId,
      clientId: authorize.client.clientId,
      ...(authorize.loginContext === undefined ? {} : { loginContext: authorize.loginContext }),
    };

    // A suspended membership cuts access to that app, and a requested login context requires
    // an active membership in that exact context (`docs/login-contexts.md` 4.1, CTX-003).
    if (options.membershipStatus !== undefined) {
      const membership = await options.membershipStatus(subject);
      if (membership === 'suspended') {
        return redirect(
          reply,
          buildErrorRedirect(
            authorize.redirectUri,
            oauthError('access_denied', 'membership is suspended'),
            authorize.state,
          ),
        );
      }
      if (authorize.loginContext !== undefined && membership !== 'active') {
        return redirect(
          reply,
          buildErrorRedirect(
            authorize.redirectUri,
            oauthError('access_denied', 'membership is required for this login context'),
            authorize.state,
          ),
        );
      }
      // A client with active login contexts manages access per context. An unbound request
      // is not context-bound (`docs/login-contexts.md` 4.1), so the only thing it can rely
      // on is the client-wide membership (`login_context_id IS NULL`). Without an active one
      // there is no membership to apply: failing closed here stops a user who only holds a
      // context membership (possibly suspended) from receiving an unnarrowed token by
      // simply omitting the parameter.
      if (
        authorize.loginContext === undefined &&
        (authorize.client.loginContexts?.length ?? 0) > 0 &&
        membership !== 'active'
      ) {
        return redirect(
          reply,
          buildErrorRedirect(
            authorize.redirectUri,
            oauthError('access_denied', 'an active client membership is required'),
            authorize.state,
          ),
        );
      }
    }

    // The MFA policy is enforced here, server-side, because the login endpoint's clientId is
    // caller-controlled. Without this, a password-only (or social) session would silently
    // bypass `required_*` policies and step-up contexts.
    if (options.authenticationRequirement !== undefined || authorize.acrValues.length > 0) {
      const requirement =
        options.authenticationRequirement === undefined
          ? { mfaRequired: false, freshAuthenticationRequired: false }
          : await options.authenticationRequirement(subject);
      // An explicit `acr_values` request for the MFA ACR is honoured as well.
      const mfaRequired = requirement.mfaRequired || authorize.acrValues.includes(MFA_ACR);
      const mfaSatisfied = sessionProvesMultiFactor(session);
      const freshEnough =
        !requirement.freshAuthenticationRequired ||
        !isAuthenticationTooOld(session, STEP_UP_MAX_AGE_SECONDS, now());
      if ((mfaRequired && !mfaSatisfied) || !freshEnough) {
        if (wantsSilent) {
          return redirect(
            reply,
            buildErrorRedirect(
              authorize.redirectUri,
              oauthError('login_required', 'a stronger authentication is required'),
              authorize.state,
            ),
          );
        }
        const loginRequest =
          options.loginRequests === undefined
            ? undefined
            : await options.loginRequests.create({
                clientId: authorize.client.clientId,
                authorizeUrl: new URL(returnTo, options.issuer).toString(),
              });
        return redirect(reply, buildLoginRedirect(loginUrl, authorize, returnTo, loginRequest));
      }
    }

    if (
      authorize.scopes.includes(CLIENT_ADMIN_SCOPE) &&
      options.isClientAdminEligible !== undefined &&
      !(await options.isClientAdminEligible(session.userId, authorize.client.clientId))
    ) {
      return redirect(
        reply,
        buildErrorRedirect(
          authorize.redirectUri,
          oauthError('access_denied', 'client administration permission is required'),
          authorize.state,
        ),
      );
    }

    const consentNeeded = !(await isConsentGranted(
      session.userId,
      authorize.client.clientId,
      authorize.scopes,
    ));
    if (consentNeeded) {
      if (wantsSilent) {
        return redirect(
          reply,
          buildErrorRedirect(
            authorize.redirectUri,
            oauthError('consent_required'),
            authorize.state,
          ),
        );
      }
      return redirect(reply, consentUrl);
    }

    const { code } = await issueAuthorizationCode(options.codes, {
      clientId: authorize.client.clientId,
      userId: session.userId,
      sessionId: session.sid,
      redirectUri: authorize.redirectUri,
      scope: authorize.scopes,
      nonce: authorize.nonce,
      codeChallenge: authorize.codeChallenge,
      // `auth_time` is the moment the user actually authenticated, which survives session
      // rotation (docs/auth-flows.md 3.2); `createdAt` moves on rotation and would overstate
      // how fresh the authentication is.
      authTime: new Date(session.authTime),
      acr: session.acr,
      amr: session.amr,
      ...(authorize.loginContext === undefined ? {} : { loginContext: authorize.loginContext }),
      now: now(),
    });

    // A code issued for another context of the same app is a context switch: the session
    // records the context it now acts in and the change is audited
    // (docs/login-contexts.md 3.4, 6). A client-wide session that binds to a context for the
    // first time is recorded the same way, so the session never claims a stale context.
    if (authorize.loginContext !== undefined && authorize.loginContext !== session.loginContext) {
      const previous = session.loginContext ?? null;
      const nextContext = authorize.loginContext;
      try {
        const rebound = await options.sessions.rebindContext?.(session.sid, nextContext);
        if (rebound !== null && rebound !== undefined) {
          await options.persistContextSwitch?.(rebound.sid, nextContext);
        }
        await options.audit?.record({
          actorType: 'user',
          actorId: session.userId,
          action: 'session.context_switch',
          targetType: 'session',
          targetId: session.sid,
          clientId: authorize.client.clientId,
          result: 'success',
          metadata: { from: previous, to: nextContext, source: 'authorize' },
        });
      } catch {
        // The authorization code is already issued: a bookkeeping failure must not turn a
        // successful authorization into an error redirect.
      }
    }

    return reply
      .header('Cache-Control', 'no-store')
      .header('X-Authorization-Code-TTL', String(AUTHORIZATION_CODE_TTL_SECONDS))
      .redirect(buildCodeRedirect(authorize.redirectUri, code, authorize.state), 302);
  });
}

export function isAuthenticationTooOld(
  session: { authTime?: string | Date | undefined },
  maxAgeSeconds: number,
  now: Date,
): boolean {
  // Sessions created before `authTime` existed carry no timestamp; `NaN > x` is false, which
  // would make `max_age` silently pass, so an unknown authentication time counts as stale.
  const authTimeMs =
    session.authTime === undefined ? Number.NaN : new Date(session.authTime).getTime();
  if (!Number.isFinite(authTimeMs)) {
    return true;
  }
  return now.getTime() - authTimeMs > maxAgeSeconds * 1000;
}
