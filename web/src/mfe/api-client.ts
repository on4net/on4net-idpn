/**
 * Client for the per-app membership endpoints used by the `user-management` MFE.
 *
 * The token never leaves memory: in BFF mode the host omits `getAccessToken` and the app's
 * BFF authenticates the request with the session cookie; in SPA mode the host injects an
 * in-memory token getter. Nothing is written to `localStorage`/`sessionStorage`.
 */

export type MemberStatus = 'invited' | 'active' | 'suspended';

export interface MfeMember {
  membershipId: string;
  userId: string;
  email: string;
  username: string;
  displayName: string;
  userStatus: string;
  status: MemberStatus;
  attributes: Record<string, unknown>;
  roleKeys: string[];
  invitedAt: string | null;
  joinedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MfeMemberPage {
  items: MfeMember[];
  page: number;
  limit: number;
  total: number;
}

export interface MfeRole {
  id: string;
  key: string;
  name: string;
  description: string;
  isDefault: boolean;
}

export interface ListMembersParams {
  page?: number;
  limit?: number;
  q?: string;
  status?: MemberStatus;
}

export interface InviteMemberInput {
  email: string;
  displayName?: string;
  roleKeys: string[];
  attributes: Record<string, unknown>;
}

export interface UpdateMemberInput {
  status?: MemberStatus;
  attributes?: Record<string, unknown>;
}

export type MfeApiErrorKind =
  'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'network' | 'server';

export class MfeApiError extends Error {
  readonly kind: MfeApiErrorKind;
  readonly status: number;
  readonly detail: string | undefined;

  constructor(kind: MfeApiErrorKind, status: number, message: string, detail?: string) {
    super(message);
    this.name = 'MfeApiError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

const kindOf = (status: number): MfeApiErrorKind => {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'invalid';
  return 'server';
};

export interface MfeApiClient {
  listMembers(
    params?: ListMembersParams,
    options?: { signal?: AbortSignal },
  ): Promise<MfeMemberPage>;
  listRoles(options?: { signal?: AbortSignal }): Promise<MfeRole[]>;
  inviteMember(input: InviteMemberInput): Promise<{ member: MfeMember; createdUser: boolean }>;
  updateMember(userId: string, input: UpdateMemberInput): Promise<MfeMember>;
  replaceRoles(userId: string, roleKeys: string[]): Promise<MfeMember>;
}

export interface MfeApiClientOptions {
  /** Public client id of the host application; supplies the API scope. */
  clientId: string;
  /** BFF base URL; defaults to same-origin. */
  baseUrl?: string;
  /** SPA mode only. Must return a token held in memory. */
  getAccessToken?: () => string | null;
  fetchImpl?: typeof fetch;
}

export function createMfeApiClient(options: MfeApiClientOptions): MfeApiClient {
  const base = (options.baseUrl ?? '').replace(/\/+$/, '');
  const doFetch =
    options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const root = `${base}/api/v1/clients/${encodeURIComponent(options.clientId)}`;

  const call = async <T>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
    absolute = false,
  ): Promise<T> => {
    const token = options.getAccessToken?.() ?? null;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    };
    if (token !== null && token !== '') {
      headers['Authorization'] = ['Bearer', token].join(' ');
    }

    let response: Response;
    try {
      response = await doFetch(absolute ? `${base}${path}` : `${root}${path}`, {
        ...init,
        credentials: 'include',
        headers: { ...headers, ...(init.headers ?? {}) },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw new MfeApiError('network', 0, 'network error');
    }

    const payload: unknown = await response.json().catch((): unknown => null);
    if (!response.ok) {
      const problem = payload as { detail?: unknown; title?: unknown } | null;
      const detail = typeof problem?.detail === 'string' ? problem.detail : undefined;
      const title = typeof problem?.title === 'string' ? problem.title : 'request failed';
      throw new MfeApiError(kindOf(response.status), response.status, title, detail);
    }
    return payload as T;
  };

  const query = (params: ListMembersParams): string => {
    const search = new URLSearchParams();
    if (params.page !== undefined) search.set('page', String(params.page));
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.q !== undefined && params.q !== '') search.set('q', params.q);
    if (params.status !== undefined) search.set('status', params.status);
    const serialized = search.toString();
    return serialized === '' ? '' : `?${serialized}`;
  };

  return {
    listMembers: (params = {}, callOptions = {}) =>
      call<MfeMemberPage>(`/members${query(params)}`, { method: 'GET' }, callOptions.signal),
    listRoles: async (callOptions = {}) => {
      const page = await call<{ items: MfeRole[] }>(
        `/api/v1/roles?clientId=${encodeURIComponent(options.clientId)}&limit=100`,
        { method: 'GET' },
        callOptions.signal,
        true,
      );
      return page.items;
    },
    inviteMember: (input) =>
      call<{ member: MfeMember; createdUser: boolean }>('/members/invite', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    updateMember: (userId, input) =>
      call<MfeMember>(`/members/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    replaceRoles: (userId, roleKeys) =>
      call<MfeMember>(`/members/${encodeURIComponent(userId)}/roles`, {
        method: 'PUT',
        body: JSON.stringify({ roleKeys }),
      }),
  };
}
