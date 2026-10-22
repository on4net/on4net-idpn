export type OAuthErrorCode =
  | 'invalid_request'
  | 'unauthorized_client'
  | 'invalid_scope'
  | 'unsupported_response_type'
  | 'unsupported_grant_type'
  | 'invalid_grant'
  | 'invalid_client'
  | 'access_denied'
  | 'login_required'
  | 'interaction_required'
  | 'consent_required'
  | 'server_error';

export interface OAuthError {
  error: OAuthErrorCode;
  description?: string;
}

export function oauthError(error: OAuthErrorCode, description?: string): OAuthError {
  return description === undefined ? { error } : { error, description };
}

/** Builds the redirect back to the client with `error`, `error_description` and `state`. */
export function buildErrorRedirect(redirectUri: string, error: OAuthError, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error.error);
  if (error.description !== undefined) {
    url.searchParams.set('error_description', error.description);
  }
  if (state !== undefined) {
    url.searchParams.set('state', state);
  }
  return url.toString();
}

/** Builds the success redirect carrying the authorization code. */
export function buildCodeRedirect(redirectUri: string, code: string, state: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  return url.toString();
}
