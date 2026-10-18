import type { OAuthClient } from './client-repository.js';
import { oauthError, type OAuthError } from './oauth-error.js';

const RESPONSE_TYPE = 'code';
const PKCE_METHOD = 'S256';
const ALLOWED_PROMPTS = new Set(['none', 'login', 'consent', 'select_account']);

/** Raw query parameters of `GET /oauth2/authorize` (docs/auth-flows.md 2.1). */
export interface AuthorizeQuery {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  prompt?: string;
  max_age?: string;
  login_hint?: string;
  acr_values?: string;
  ui_locales?: string;
  login_context?: string;
  tenant?: string;
}

export interface ValidatedAuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  scopes: string[];
  state: string;
  nonce: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  prompt: string[];
  maxAge?: number;
  loginHint?: string;
  acrValues: string[];
  uiLocales?: string;
  loginContext?: string;
}

export type AuthorizeValidation =
  | { ok: true; request: ValidatedAuthorizeRequest }
  /** `redirectUri` is present only when the client and redirect URI were already validated. */
  | { ok: false; error: OAuthError; redirectUri?: string; state?: string };

/**
 * Validates an authorization request against docs/auth-flows.md 2.2.
 *
 * Redirect URI matching is an exact string comparison against the registered list; wildcards
 * are rejected even if an operator stored one by mistake.
 */
export function validateAuthorizeRequest(
  query: AuthorizeQuery,
  client: OAuthClient | null,
): AuthorizeValidation {
  if (query.client_id === undefined || query.client_id === '') {
    return { ok: false, error: oauthError('invalid_request', 'client_id is required') };
  }
  if (client === null || client.status !== 'active') {
    return { ok: false, error: oauthError('unauthorized_client', 'unknown or disabled client') };
  }

  const redirectUri = query.redirect_uri;
  if (redirectUri === undefined || redirectUri === '') {
    return { ok: false, error: oauthError('invalid_request', 'redirect_uri is required') };
  }
  if (!isRegisteredRedirectUri(client, redirectUri)) {
    // Never redirect to an unregistered URI; report the error to the user agent instead.
    return { ok: false, error: oauthError('invalid_request', 'redirect_uri is not registered') };
  }

  const state = query.state;
  const fail = (error: OAuthError): AuthorizeValidation => ({
    ok: false,
    error,
    redirectUri,
    ...(state === undefined || state === '' ? {} : { state }),
  });

  if (query.response_type !== RESPONSE_TYPE) {
    return fail(oauthError('unsupported_response_type', 'only response_type=code is supported'));
  }
  if (state === undefined || state === '') {
    return fail(oauthError('invalid_request', 'state is required'));
  }
  if (query.nonce === undefined || query.nonce === '') {
    return fail(oauthError('invalid_request', 'nonce is required'));
  }

  const scopes = (query.scope ?? '').split(/\s+/).filter((scope) => scope !== '');
  if (scopes.length === 0 || !scopes.includes('openid')) {
    return fail(oauthError('invalid_scope', 'scope must include openid'));
  }
  const unknownScope = scopes.find((scope) => !client.scopes.includes(scope));
  if (unknownScope !== undefined) {
    return fail(oauthError('invalid_scope', `scope "${unknownScope}" is not allowed`));
  }

  if (query.code_challenge === undefined || query.code_challenge === '') {
    return fail(oauthError('invalid_request', 'code_challenge is required (PKCE)'));
  }
  if (!isValidChallenge(query.code_challenge)) {
    return fail(
      oauthError('invalid_request', 'code_challenge must be a 43-128 character S256 digest'),
    );
  }
  if (query.code_challenge_method !== PKCE_METHOD) {
    return fail(oauthError('invalid_request', 'code_challenge_method must be S256'));
  }

  const prompt = (query.prompt ?? '').split(/\s+/).filter((value) => value !== '');
  const invalidPrompt = prompt.find((value) => !ALLOWED_PROMPTS.has(value));
  if (invalidPrompt !== undefined) {
    return fail(oauthError('invalid_request', `unsupported prompt "${invalidPrompt}"`));
  }

  let maxAge: number | undefined;
  if (query.max_age !== undefined && query.max_age !== '') {
    const parsed = Number(query.max_age);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return fail(oauthError('invalid_request', 'max_age must be a non-negative integer'));
    }
    maxAge = parsed;
  }

  if (query.login_context !== undefined && query.login_context !== '') {
    const contexts = client.loginContexts ?? [];
    if (!contexts.includes(query.login_context)) {
      return fail(oauthError('invalid_request', 'login_context is not enabled for this client'));
    }
  }

  const request: ValidatedAuthorizeRequest = {
    client,
    redirectUri,
    scopes,
    state,
    nonce: query.nonce,
    codeChallenge: query.code_challenge,
    codeChallengeMethod: PKCE_METHOD,
    prompt,
    acrValues: (query.acr_values ?? '').split(/\s+/).filter((value) => value !== ''),
    ...(maxAge === undefined ? {} : { maxAge }),
    ...(query.login_hint === undefined || query.login_hint === ''
      ? {}
      : { loginHint: query.login_hint }),
    ...(query.ui_locales === undefined || query.ui_locales === ''
      ? {}
      : { uiLocales: query.ui_locales }),
    ...(query.login_context === undefined || query.login_context === ''
      ? {}
      : { loginContext: query.login_context }),
  };

  return { ok: true, request };
}

function isRegisteredRedirectUri(client: OAuthClient, candidate: string): boolean {
  if (candidate.includes('*')) {
    return false;
  }
  return client.redirectUris.some(
    (registered) => !registered.includes('*') && registered === candidate,
  );
}

/** S256 challenges are base64url-encoded SHA-256 digests: 43 characters, no padding. */
function isValidChallenge(challenge: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(challenge);
}
