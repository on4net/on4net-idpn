/** Client fields the authorization endpoint needs. */
export interface OAuthClient {
  clientId: string;
  status: 'active' | 'disabled';
  type: 'web' | 'spa' | 'mobile' | 'm2m';
  redirectUris: string[];
  /** Exact post-logout redirect URIs; wildcards are never valid (docs/auth-flows.md 6.2). */
  postLogoutRedirectUris?: string[];
  /** Client endpoint that receives a signed Logout Token (docs/auth-flows.md 6.3). */
  backchannelLogoutUri?: string | null;
  scopes: string[];
  requirePkce: boolean;
  registrationPolicy: 'invite_only' | 'self_service' | 'disabled';
  mfaPolicy: 'optional' | 'required_admins' | 'required_all';
  /** Active login context keys, when the feature is in use. */
  loginContexts?: string[];
  /**
   * Key of the context marked `is_default` (docs/login-contexts.md 4.1). When the request omits
   * `login_context`, this is the effective context — never a context-free grant.
   */
  defaultLoginContext?: string;
  /** Locales enabled for this client. */
  locales?: string[];
}

export interface ClientRepository {
  findByClientId(clientId: string): Promise<OAuthClient | null>;
}
