/** Client fields the authorization endpoint needs. */
export interface OAuthClient {
  clientId: string;
  status: 'active' | 'disabled';
  type: 'web' | 'spa' | 'mobile' | 'm2m';
  redirectUris: string[];
  scopes: string[];
  requirePkce: boolean;
  registrationPolicy: 'invite_only' | 'self_service' | 'disabled';
  mfaPolicy: 'optional' | 'required_admins' | 'required_all';
  /** Active login context keys, when the feature is in use. */
  loginContexts?: string[];
  /** Locales enabled for this client. */
  locales?: string[];
}

export interface ClientRepository {
  findByClientId(clientId: string): Promise<OAuthClient | null>;
}
