import type { FastifyInstance, FastifyReply } from 'fastify';

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
}

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
): string {
  const target = new URL(loginUrl, 'http://placeholder.invalid');
  target.searchParams.set('client_id', authorize.client.clientId);
  target.searchParams.set('return_to', requestUrl);
  if (authorize.uiLocales !== undefined) {
    target.searchParams.set('ui_locales', authorize.uiLocales);
  }
  if (authorize.loginHint !== undefined) {
    target.searchParams.set('login_hint', authorize.loginHint);
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

    if (session === null) {
      if (wantsSilent) {
        return redirect(
          reply,
          buildErrorRedirect(authorize.redirectUri, oauthError('login_required'), authorize.state),
        );
      }
      return redirect(reply, buildLoginRedirect(loginUrl, authorize, returnTo));
    }

    if (
      authorize.maxAge !== undefined &&
      isAuthenticationTooOld(session, authorize.maxAge, now())
    ) {
      const error = wantsSilent
        ? oauthError('login_required', 're-authentication required')
        : oauthError('interaction_required', 're-authentication required');
      return redirect(reply, buildErrorRedirect(authorize.redirectUri, error, authorize.state));
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
      authTime: new Date(session.createdAt),
      acr: session.acr,
      amr: session.amr,
      ...(authorize.loginContext === undefined ? {} : { loginContext: authorize.loginContext }),
      now: now(),
    });

    return reply
      .header('Cache-Control', 'no-store')
      .header('X-Authorization-Code-TTL', String(AUTHORIZATION_CODE_TTL_SECONDS))
      .redirect(buildCodeRedirect(authorize.redirectUri, code, authorize.state), 302);
  });
}

function isAuthenticationTooOld(session: IdpSession, maxAgeSeconds: number, now: Date): boolean {
  return now.getTime() - new Date(session.authTime).getTime() > maxAgeSeconds * 1000;
}
