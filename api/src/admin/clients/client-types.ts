import type { ClientType, MfaPolicy, RegistrationPolicy } from './client-validation.js';

export interface AdminClientSummary {
  clientId: string;
  name: string;
  type: ClientType;
  status: 'active' | 'disabled';
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  allowedOrigins: string[];
  scopes: string[];
  accessTokenTtl: number;
  refreshTokenTtl: number;
  requirePkce: boolean;
  registrationPolicy: RegistrationPolicy;
  /** False requires a recorded user consent per scope (`docs/api.md` 3.3). */
  firstParty: boolean;
  mfaPolicy: MfaPolicy;
  backchannelLogoutUri: string | null;
  frontchannelLogoutUri: string | null;
  allowedEmailDomains: string[];
  locales: Record<string, unknown>;
  branding: Record<string, unknown>;
  mfeFeatures: Record<string, unknown>;
  membershipSchema: Record<string, unknown> | null;
  defaultLoginContextKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientSecretSummary {
  id: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface AdminClientDetail extends AdminClientSummary {
  /** Internal UUID; used for audit targets and never treated as a secret. */
  id: string;
  secrets: ClientSecretSummary[];
}

export interface CreateClientInput {
  clientId: string;
  name: string;
  type: ClientType;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  allowedOrigins: string[];
  scopes: string[];
  accessTokenTtl: number;
  refreshTokenTtl: number;
  requirePkce: boolean;
  registrationPolicy: RegistrationPolicy;
  /** False requires a recorded user consent per scope (`docs/api.md` 3.3). */
  firstParty: boolean;
  mfaPolicy: MfaPolicy;
  backchannelLogoutUri: string | null;
  frontchannelLogoutUri: string | null;
  allowedEmailDomains: string[];
  locales: Record<string, unknown>;
  branding: Record<string, unknown>;
  mfeFeatures: Record<string, unknown>;
  membershipSchema: Record<string, unknown> | null;
}

export type UpdateClientInput = Partial<Omit<CreateClientInput, 'clientId' | 'type'>> & {
  name?: string;
};

export interface ClientRevocation {
  client: AdminClientDetail;
  revokedCodes: number;
  revokedRefreshTokens: number;
  revokedSessions: number;
}

export interface ClientSecretRotationPolicy {
  at: Date;
  /** Predecessors keep working this long after the new secret is issued. */
  graceMs: number;
  /** Maximum number of non-revoked, non-expired secrets, the new one included. */
  maxActive: number;
}

/** Raised when issuing another secret would exceed the active-secret cap. */
export class ClientSecretLimitError extends Error {
  constructor(readonly maxActive: number) {
    super(`a client holds at most ${String(maxActive)} active secrets`);
    this.name = 'ClientSecretLimitError';
  }
}

export interface AdminClientRepository {
  list(input: {
    page: number;
    limit: number;
    query?: string;
    status?: 'active' | 'disabled';
  }): Promise<{ items: AdminClientSummary[]; total: number }>;
  findByClientId(clientId: string): Promise<AdminClientDetail | null>;
  create(input: CreateClientInput): Promise<AdminClientDetail>;
  update(clientId: string, input: UpdateClientInput): Promise<AdminClientDetail | null>;
  /**
   * Stores a secret. With `rotation`, the predecessors are given a bounded grace window and the
   * call throws {@link ClientSecretLimitError} when too many secrets are still usable.
   */
  addSecret(
    clientId: string,
    secret: { secretHash: string; prefix: string; expiresAt: Date | null },
    rotation?: ClientSecretRotationPolicy,
  ): Promise<ClientSecretSummary | null>;
  revokeSecret(clientId: string, secretId: string, at: Date): Promise<boolean>;
  disable(clientId: string, at: Date): Promise<ClientRevocation | null>;
}
