/**
 * Admin API types for per-app login contexts (docs/api.md 3.3.3,
 * docs/login-contexts.md 3.1, docs/domain-model.md 2.6.3).
 */

export const LOGIN_CONTEXT_STATUSES = ['active', 'disabled'] as const;
export type LoginContextStatus = (typeof LOGIN_CONTEXT_STATUSES)[number];

export const LOGIN_METHODS = ['password', 'google', 'facebook', 'otp', 'sso'] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export const LOGIN_CONTEXT_MFA_POLICIES = ['optional', 'required_admins', 'required_all'] as const;
export type LoginContextMfaPolicy = (typeof LOGIN_CONTEXT_MFA_POLICIES)[number];

export const LOGIN_CONTEXT_REGISTRATION_POLICIES = [
  'invite_only',
  'self_service',
  'disabled',
] as const;
export type LoginContextRegistrationPolicy = (typeof LOGIN_CONTEXT_REGISTRATION_POLICIES)[number];

/** Serialized admin representation of one login context. */
export interface AdminLoginContext {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: LoginContextStatus;
  isDefault: boolean;
  /** Role keys owned by the same client; global `idp:*` roles are never accepted. */
  allowedRoles: string[];
  defaultRoles: string[];
  loginMethods: string[];
  mfaPolicy: LoginContextMfaPolicy;
  registrationPolicy: LoginContextRegistrationPolicy;
  allowedEmailDomains: string[];
  sessionIdleTtl: number;
  sessionAbsoluteTtl: number;
  stepUpRequired: boolean;
  branding: Record<string, unknown> | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLoginContextInput {
  key: string;
  name: string;
  description: string | null;
  allowedRoles: string[];
  defaultRoles: string[];
  loginMethods: string[];
  mfaPolicy: LoginContextMfaPolicy;
  registrationPolicy: LoginContextRegistrationPolicy;
  allowedEmailDomains: string[];
  sessionIdleTtl: number;
  sessionAbsoluteTtl: number;
  stepUpRequired: boolean;
  isDefault: boolean;
  branding: Record<string, unknown> | null;
  sortOrder: number;
}

export type UpdateLoginContextInput = Partial<Omit<CreateLoginContextInput, 'key'>>;

export type LoginContextFailureReason =
  /** The `{clientId}` path segment does not match a client row. */
  | 'client-not-found'
  /** The client exists but has no context with that key. */
  | 'not-found'
  /** `(client_id, key)` is already taken. */
  | 'duplicate'
  /** A client must keep exactly one default context; assign another one first. */
  | 'default-context'
  /** Memberships still reference the context. */
  | 'in-use';

export type LoginContextResult<T> =
  { ok: true; value: T } | { ok: false; reason: LoginContextFailureReason; detail: string };

/** Persistence port for the login context administration endpoints. */
export interface AdminLoginContextRepository {
  list(clientId: string): Promise<LoginContextResult<AdminLoginContext[]>>;
  find(clientId: string, key: string): Promise<LoginContextResult<AdminLoginContext | null>>;
  /** Role keys owned by the client, without the global `idp:*` catalog. */
  roleKeys(clientId: string): Promise<LoginContextResult<string[]>>;
  create(
    clientId: string,
    input: CreateLoginContextInput,
  ): Promise<LoginContextResult<AdminLoginContext>>;
  update(
    clientId: string,
    key: string,
    input: UpdateLoginContextInput,
  ): Promise<LoginContextResult<AdminLoginContext>>;
  /** Marks the context `disabled`; the row and its memberships are kept. */
  disable(clientId: string, key: string): Promise<LoginContextResult<AdminLoginContext>>;
  /** Returns a disabled context to `active`; idempotent when it already is. */
  enable(clientId: string, key: string): Promise<LoginContextResult<AdminLoginContext>>;
  remove(clientId: string, key: string): Promise<LoginContextResult<null>>;
}
