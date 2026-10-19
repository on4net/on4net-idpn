/**
 * Client for the same-origin `/api/v1/account/*` surface (docs/account-api.md).
 *
 * The embedded account module runs on the IdP origin: authentication is the HttpOnly
 * `idpn_session` cookie, so no token ever reaches JavaScript, events or storage.
 */

export type AccountStatus = 'active' | 'locked' | 'disabled' | 'pending';

export interface AccountProfile {
  id: string;
  username: string;
  email: string;
  displayName: string;
  phone: string | null;
  avatarUrl: string | null;
  locale: string;
  status: AccountStatus;
  emailVerified: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  passwordChangedAt: string | null;
}

export interface AccountSession {
  id: string;
  userId: string;
  clientId: string | null;
  status: 'active' | 'revoked' | 'expired';
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  ip: string | null;
  userAgent: string | null;
  amr: readonly string[];
  acr: string;
  revokedAt: string | null;
  revokeReason: string | null;
  /** `true` for the session that issued the current cookie. */
  current: boolean;
}

export interface AccountSessionPage {
  items: AccountSession[];
  page: number;
  limit: number;
  total: number;
}

export interface ChangePasswordResult {
  ok: true;
  revokedSessions: number;
  revokedRefreshTokens: number;
  keptCurrentSession: true;
}

/** MFA status of the signed-in account (docs/auth-flows.md 7). */
export interface AccountMfaFactor {
  id: string;
  type: 'totp' | 'webauthn';
  name: string;
  confirmed: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AccountMfaStatus {
  factors: AccountMfaFactor[];
  totp: AccountMfaFactor | null;
  recoveryCodesRemaining: number;
  available: boolean;
}

export interface TotpEnrollment {
  factorId: string;
  /** Base32 secret; returned exactly once and never again. */
  secret: string;
  otpauthUri: string;
  algorithm: string;
  digits: number;
  period: number;
}

export interface TotpDisableInput {
  password?: string;
  code?: string;
  factorId?: string;
}

export type AccountApiErrorKind =
  'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'network' | 'server';

/** RFC 9457 problem with the account extension members (`code`, `violations`). */
export class AccountApiError extends Error {
  readonly kind: AccountApiErrorKind;
  readonly status: number;
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly violations: readonly string[];

  constructor(
    kind: AccountApiErrorKind,
    status: number,
    message: string,
    options: { code?: string; detail?: string; violations?: readonly string[] } = {},
  ) {
    super(message);
    this.name = 'AccountApiError';
    this.kind = kind;
    this.status = status;
    this.code = options.code;
    this.detail = options.detail;
    this.violations = options.violations ?? [];
  }
}

const kindOf = (status: number): AccountApiErrorKind => {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'invalid';
  return 'server';
};

interface ProblemBody {
  title?: unknown;
  detail?: unknown;
  code?: unknown;
  violations?: unknown;
}

export interface AccountApiClient {
  getProfile(options?: { signal?: AbortSignal }): Promise<AccountProfile>;
  changePassword(input: {
    currentPassword: string;
    newPassword: string;
  }): Promise<ChangePasswordResult>;
  listSessions(
    params?: { page?: number; limit?: number },
    options?: { signal?: AbortSignal },
  ): Promise<AccountSessionPage>;
  closeSession(sid: string): Promise<{ revoked: boolean; alreadyRevoked: boolean }>;
  getMfaStatus(options?: { signal?: AbortSignal }): Promise<AccountMfaStatus>;
  enrollTotp(input?: { name?: string }): Promise<TotpEnrollment>;
  verifyTotpEnrollment(input: { factorId: string; code: string }): Promise<{
    ok: true;
    recoveryCodes: string[];
  }>;
  disableTotp(input: TotpDisableInput): Promise<{ ok: true }>;
  regenerateRecoveryCodes(input: { password: string }): Promise<{ recoveryCodes: string[] }>;
}

export interface AccountApiClientOptions {
  /** Same-origin by default; hosts may pass the IdP base URL explicitly. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createAccountApiClient(options: AccountApiClientOptions = {}): AccountApiClient {
  const base = (options.baseUrl ?? '').replace(/\/+$/, '');
  const doFetch =
    options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  const call = async <T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    };

    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        ...init,
        credentials: 'include',
        headers: { ...headers, ...(init.headers ?? {}) },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (isAbort(error)) {
        throw error;
      }
      throw new AccountApiError('network', 0, 'network error');
    }

    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.toLowerCase().includes('application/json');
    const payload: unknown = isJson ? await response.json().catch((): unknown => null) : null;

    if (!response.ok) {
      const problem = (payload ?? {}) as ProblemBody;
      const detail = typeof problem.detail === 'string' ? problem.detail : undefined;
      const title = typeof problem.title === 'string' ? problem.title : 'request failed';
      throw new AccountApiError(kindOf(response.status), response.status, title, {
        ...(typeof problem.code === 'string' ? { code: problem.code } : {}),
        ...(detail === undefined ? {} : { detail }),
        ...(Array.isArray(problem.violations)
          ? {
              violations: problem.violations.filter(
                (entry): entry is string => typeof entry === 'string',
              ),
            }
          : {}),
      });
    }

    // A host/dev-server HTML fallback must never be treated as a valid account response.
    if (!isJson) {
      throw new AccountApiError('server', response.status, 'invalid response');
    }
    return payload as T;
  };

  const query = (params: { page?: number; limit?: number }): string => {
    const search = new URLSearchParams();
    if (params.page !== undefined) search.set('page', String(params.page));
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    const serialized = search.toString();
    return serialized === '' ? '' : `?${serialized}`;
  };

  return {
    getProfile: (callOptions = {}) =>
      call<AccountProfile>('/api/v1/account/profile', { method: 'GET' }, callOptions.signal),
    changePassword: (input) =>
      call<ChangePasswordResult>('/api/v1/account/password', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    listSessions: (params = {}, callOptions = {}) =>
      call<AccountSessionPage>(
        `/api/v1/account/sessions${query(params)}`,
        { method: 'GET' },
        callOptions.signal,
      ),
    closeSession: (sid) =>
      call<{ revoked: boolean; alreadyRevoked: boolean }>(
        `/api/v1/account/sessions/${encodeURIComponent(sid)}`,
        { method: 'DELETE' },
      ),
    getMfaStatus: (callOptions = {}) =>
      call<AccountMfaStatus>('/api/v1/account/mfa', { method: 'GET' }, callOptions.signal),
    enrollTotp: (input = {}) =>
      call<TotpEnrollment>('/api/v1/account/mfa/totp/enroll', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    verifyTotpEnrollment: (input) =>
      call<{ ok: true; recoveryCodes: string[] }>('/api/v1/account/mfa/totp/verify', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    disableTotp: (input) =>
      call<{ ok: true }>('/api/v1/account/mfa/totp/disable', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    regenerateRecoveryCodes: (input) =>
      call<{ recoveryCodes: string[] }>('/api/v1/account/mfa/recovery-codes', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  };
}

function isAbort(error: unknown): boolean {
  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'AbortError'
  );
}
