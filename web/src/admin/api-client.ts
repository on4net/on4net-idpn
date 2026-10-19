/**
 * Typed client for the global Admin API (`docs/api.md` 3).
 *
 * The access token is supplied by the caller — the console never keeps it in
 * `localStorage`/`sessionStorage`; it lives in memory for the lifetime of the page.
 */

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  phone: string | null;
  locale: string;
  status: 'active' | 'pending' | 'locked' | 'disabled';
  emailVerified: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserPage {
  items: AdminUser[];
  page: number;
  limit: number;
  total: number;
}

export interface AdminMe {
  id: string;
  clientId: string;
  scopes: string[];
  permissions: string[];
}

export interface CreateUserInput {
  username: string;
  email: string;
  displayName: string;
  locale?: string;
}

export interface UpdateUserInput {
  email?: string;
  displayName?: string;
  locale?: string;
}

export interface ListUsersParams {
  page?: number;
  limit?: number;
  q?: string;
  status?: AdminUser['status'];
  sort?: string;
}

export interface AdminAuditEvent {
  id: string;
  occurredAt: string;
  actorType: 'user' | 'admin' | 'service' | 'system' | 'anonymous';
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  clientId: string | null;
  ip: string | null;
  userAgent: string | null;
  result: 'success' | 'failure';
  metadata: Record<string, unknown>;
}

export interface AuditEventPage {
  items: AdminAuditEvent[];
  page: number;
  limit: number;
  total: number;
}

export interface AuditEventFilters {
  /** ISO 8601 timestamp. */
  from?: string;
  /** ISO 8601 timestamp. */
  to?: string;
  action?: string;
  actorId?: string;
  /** Public client id. */
  clientId?: string;
  targetType?: string;
  result?: AdminAuditEvent['result'];
}

export interface ListAuditEventsParams extends AuditEventFilters {
  page?: number;
  limit?: number;
}

export type AuditExportFormat = 'csv' | 'ndjson';

export interface ExportAuditEventsParams extends AuditEventFilters {
  format: AuditExportFormat;
}

export interface ActionResult {
  user: AdminUser;
  revokedSessions: number;
  temporaryPassword?: string;
}

export type AdminSessionStatus = 'active' | 'revoked' | 'expired';

export interface AdminSession {
  id: string;
  userId: string;
  clientId: string | null;
  status: AdminSessionStatus;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  ip: string | null;
  userAgent: string | null;
  amr: string[];
  acr: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface AdminSessionPage {
  items: AdminSession[];
  page: number;
  limit: number;
  total: number;
}

export interface ListSessionsParams {
  page?: number;
  limit?: number;
  userId?: string;
  clientId?: string;
  status?: AdminSessionStatus;
}

export type AdminApiErrorKind =
  'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'network' | 'server';

/** Error carrying the RFC 9457 problem payload returned by the Admin API. */
export class AdminApiError extends Error {
  readonly kind: AdminApiErrorKind;
  readonly status: number;
  readonly detail: string | undefined;

  constructor(kind: AdminApiErrorKind, status: number, message: string, detail?: string) {
    super(message);
    this.name = 'AdminApiError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

const kindOf = (status: number): AdminApiErrorKind => {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422 || status === 400) return 'invalid';
  return 'server';
};

/** Maps an RFC 9457 problem body to the typed error used by the console. */
const problemError = (status: number, payload: unknown): AdminApiError => {
  const problem = payload as { detail?: unknown; title?: unknown } | null;
  const detail = typeof problem?.detail === 'string' ? problem.detail : undefined;
  const title = typeof problem?.title === 'string' ? problem.title : 'request failed';
  return new AdminApiError(kindOf(status), status, title, detail);
};

export interface AdminApiOptions {
  /** API origin; empty for same-origin deployments (including the dev proxy). */
  baseUrl?: string;
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
}

export interface AdminApiClient {
  me(): Promise<AdminMe>;
  listUsers(params?: ListUsersParams): Promise<AdminUserPage>;
  createUser(input: CreateUserInput): Promise<ActionResult>;
  updateUser(userId: string, input: UpdateUserInput): Promise<AdminUser>;
  disableUser(userId: string): Promise<ActionResult>;
  enableUser(userId: string): Promise<ActionResult>;
  unlockUser(userId: string): Promise<ActionResult>;
  resetPassword(userId: string, password?: string): Promise<ActionResult>;
  listSessions(params?: ListSessionsParams): Promise<AdminSessionPage>;
  revokeSession(sessionId: string): Promise<{ revoked: boolean; alreadyRevoked: boolean }>;
  listAuditEvents(params?: ListAuditEventsParams): Promise<AuditEventPage>;
  /** Downloads an export, keeping the token out of the returned data. */
  exportAuditEvents(params: ExportAuditEventsParams): Promise<Blob>;
}

export function createAdminApiClient(options: AdminApiOptions): AdminApiClient {
  const base = (options.baseUrl ?? '').replace(/\/+$/, '');
  const doFetch =
    options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const token = options.getToken();
    if (token === null || token === '') {
      throw new AdminApiError('unauthorized', 401, 'not signed in');
    }

    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new AdminApiError('network', 0, 'network error');
    }

    const payload: unknown = await response.json().catch((): unknown => null);
    if (!response.ok) {
      throw problemError(response.status, payload);
    }
    return payload as T;
  };

  const query = (params: ListUsersParams = {}): string => {
    const search = new URLSearchParams();
    if (params.page !== undefined) search.set('page', String(params.page));
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.q !== undefined && params.q !== '') search.set('q', params.q);
    if (params.status !== undefined) search.set('status', params.status);
    if (params.sort !== undefined) search.set('sort', params.sort);
    const serialized = search.toString();
    return serialized === '' ? '' : `?${serialized}`;
  };

  const post = (path: string, body: unknown = {}): Promise<ActionResult> =>
    call<ActionResult>(path, { method: 'POST', body: JSON.stringify(body) });

  const sessionQuery = (params: ListSessionsParams = {}): string => {
    const search = new URLSearchParams();
    if (params.page !== undefined) search.set('page', String(params.page));
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.userId !== undefined && params.userId !== '') search.set('userId', params.userId);
    if (params.clientId !== undefined && params.clientId !== '')
      search.set('clientId', params.clientId);
    if (params.status !== undefined) search.set('status', params.status);
    const serialized = search.toString();
    return serialized === '' ? '' : `?${serialized}`;
  };

  const auditQuery = (
    params: AuditEventFilters & { page?: number; limit?: number; format?: AuditExportFormat },
  ): string => {
    const search = new URLSearchParams();
    if (params.from !== undefined && params.from !== '') search.set('from', params.from);
    if (params.to !== undefined && params.to !== '') search.set('to', params.to);
    if (params.action !== undefined && params.action !== '') search.set('action', params.action);
    if (params.actorId !== undefined && params.actorId !== '')
      search.set('actorId', params.actorId);
    if (params.clientId !== undefined && params.clientId !== '')
      search.set('clientId', params.clientId);
    if (params.targetType !== undefined && params.targetType !== '')
      search.set('targetType', params.targetType);
    if (params.result !== undefined) search.set('result', params.result);
    if (params.page !== undefined) search.set('page', String(params.page));
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.format !== undefined) search.set('format', params.format);
    const serialized = search.toString();
    return serialized === '' ? '' : `?${serialized}`;
  };

  const exportAuditEvents = async (params: ExportAuditEventsParams): Promise<Blob> => {
    const token = options.getToken();
    if (token === null || token === '') {
      throw new AdminApiError('unauthorized', 401, 'not signed in');
    }

    let response: Response;
    try {
      response = await doFetch(`${base}/api/v1/audit-events/export${auditQuery(params)}`, {
        headers: {
          Accept: params.format === 'ndjson' ? 'application/x-ndjson' : 'text/csv',
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      throw new AdminApiError('network', 0, 'network error');
    }

    if (!response.ok) {
      const payload: unknown = await response.json().catch((): unknown => null);
      throw problemError(response.status, payload);
    }
    return response.blob();
  };

  return {
    me: () => call<AdminMe>('/api/v1/me'),
    listUsers: (params) => call<AdminUserPage>(`/api/v1/users${query(params)}`),
    createUser: async (input) => {
      const result = await call<{ user: AdminUser; temporaryPassword?: string }>('/api/v1/users', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return {
        user: result.user,
        revokedSessions: 0,
        ...(result.temporaryPassword === undefined
          ? {}
          : { temporaryPassword: result.temporaryPassword }),
      };
    },
    updateUser: (userId, input) =>
      call<AdminUser>(`/api/v1/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    disableUser: (userId) => post(`/api/v1/users/${encodeURIComponent(userId)}/disable`),
    enableUser: (userId) => post(`/api/v1/users/${encodeURIComponent(userId)}/enable`),
    unlockUser: (userId) => post(`/api/v1/users/${encodeURIComponent(userId)}/unlock`),
    resetPassword: (userId, password) =>
      post(
        `/api/v1/users/${encodeURIComponent(userId)}/reset-password`,
        password === undefined ? {} : { password },
      ),
    listSessions: (params = {}) =>
      call<AdminSessionPage>(`/api/v1/sessions${sessionQuery(params)}`),
    revokeSession: (sessionId) =>
      call<{ revoked: boolean; alreadyRevoked: boolean }>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE' },
      ),
    listAuditEvents: (params = {}) =>
      call<AuditEventPage>(`/api/v1/audit-events${auditQuery(params)}`),
    exportAuditEvents,
  };
}
