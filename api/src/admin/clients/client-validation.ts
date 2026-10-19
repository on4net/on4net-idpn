/**
 * Validation rules for the client administration endpoints (`docs/api.md` 3.3).
 *
 * Every rule returns a message instead of throwing so the route can report *all* problems in
 * one `422` response — a misconfigured redirect URI must never half-create a client.
 */

export const PLATFORM_SCOPES: ReadonlySet<string> = new Set([
  'openid',
  'profile',
  'email',
  'phone',
  'address',
  'offline_access',
  'idp.admin',
  'idp.client-admin',
]);

export const CLIENT_TYPES = ['web', 'spa', 'mobile', 'm2m'] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export const REGISTRATION_POLICIES = ['invite_only', 'self_service', 'disabled'] as const;
export type RegistrationPolicy = (typeof REGISTRATION_POLICIES)[number];
export const MFA_POLICIES = ['optional', 'required_admins', 'required_all'] as const;
export type MfaPolicy = (typeof MFA_POLICIES)[number];

export const MIN_ACCESS_TOKEN_TTL = 60;
export const MAX_ACCESS_TOKEN_TTL = 3600;
export const MIN_REFRESH_TOKEN_TTL = 300;
export const MAX_REFRESH_TOKEN_TTL = 31_536_000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const BRANDING_KEYS = new Set(['logoUrl', 'primaryColor', 'primary', 'radius', 'fontFamily']);

/** Absolute URI, no wildcard, no fragment, no credentials; HTTPS outside loopback. */
export function uriProblem(value: string): string | null {
  if (value.trim() !== value) {
    return 'must not have surrounding whitespace';
  }
  if (value.includes('*')) {
    return 'wildcards are not allowed';
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute URI';
  }
  if (url.hash !== '') {
    return 'must not contain a fragment';
  }
  if (url.username !== '' || url.password !== '') {
    return 'must not contain credentials';
  }
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      return 'must use https (http is only allowed for loopback addresses)';
    }
    return null;
  }
  if (url.protocol !== 'https:') {
    return 'must use the https scheme';
  }
  return null;
}

export function uriListProblems(values: readonly string[], field: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const problem = uriProblem(value);
    if (problem !== null) {
      problems.push(`${field}[${index}]: ${problem}`);
    }
    if (seen.has(value)) {
      problems.push(`${field}[${index}]: duplicate entry`);
    }
    seen.add(value);
  });
  return problems;
}

export interface ClientScopesInput {
  scopes: readonly string[];
  type: ClientType;
  /** Public id of the global admin client; only it may hold `idp.admin`. */
  adminClientId: string;
  clientId: string;
}

export function scopeProblems(input: ClientScopesInput): string[] {
  const problems: string[] = [];
  if (input.scopes.length === 0) {
    problems.push('scopes: at least one scope is required');
  }
  const unknown = input.scopes.filter((scope) => !PLATFORM_SCOPES.has(scope));
  // Service clients carry product-specific scopes (for example `reports:read`).
  if (unknown.length > 0 && input.type !== 'm2m') {
    problems.push(`scopes: unknown scope(s) ${unknown.join(', ')}`);
  }
  if (input.type !== 'm2m' && !input.scopes.includes('openid')) {
    problems.push('scopes: openid is required');
  }
  if (input.scopes.includes('idp.admin') && input.clientId !== input.adminClientId) {
    problems.push('scopes: idp.admin is reserved for the global admin client');
  }
  return problems;
}

export function ttlProblems(
  accessTokenTtl: number | undefined,
  refreshTokenTtl: number | undefined,
): string[] {
  const problems: string[] = [];
  if (
    accessTokenTtl !== undefined &&
    (accessTokenTtl < MIN_ACCESS_TOKEN_TTL || accessTokenTtl > MAX_ACCESS_TOKEN_TTL)
  ) {
    problems.push(
      `accessTokenTtl: must be between ${MIN_ACCESS_TOKEN_TTL} and ${MAX_ACCESS_TOKEN_TTL}`,
    );
  }
  if (
    refreshTokenTtl !== undefined &&
    (refreshTokenTtl < MIN_REFRESH_TOKEN_TTL || refreshTokenTtl > MAX_REFRESH_TOKEN_TTL)
  ) {
    problems.push(
      `refreshTokenTtl: must be between ${MIN_REFRESH_TOKEN_TTL} and ${MAX_REFRESH_TOKEN_TTL}`,
    );
  }
  return problems;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function brandingProblems(branding: unknown): string[] {
  if (branding === undefined) {
    return [];
  }
  if (!isPlainObject(branding)) {
    return ['branding: must be an object'];
  }
  const problems: string[] = [];
  for (const [key, value] of Object.entries(branding)) {
    if (!BRANDING_KEYS.has(key)) {
      problems.push(`branding.${key}: unknown key`);
      continue;
    }
    if (typeof value !== 'string' || value === '') {
      problems.push(`branding.${key}: must be a non-empty string`);
      continue;
    }
    if (key === 'logoUrl') {
      const problem = uriProblem(value);
      if (problem !== null) {
        problems.push(`branding.logoUrl: ${problem}`);
      }
    }
  }
  return problems;
}

export function mfeFeatureProblems(features: unknown): string[] {
  if (features === undefined) {
    return [];
  }
  if (!isPlainObject(features)) {
    return ['mfeFeatures: must be an object'];
  }
  return Object.entries(features)
    .filter(([, value]) => typeof value !== 'boolean')
    .map(([key]) => `mfeFeatures.${key}: must be a boolean`);
}

export function membershipSchemaProblems(schema: unknown): string[] {
  if (schema === undefined || schema === null) {
    return [];
  }
  if (!isPlainObject(schema)) {
    return ['membershipSchema: must be a JSON object'];
  }
  if (schema['type'] !== 'object') {
    return ['membershipSchema.type: must be "object"'];
  }
  const properties = schema['properties'];
  if (properties !== undefined && !isPlainObject(properties)) {
    return ['membershipSchema.properties: must be an object'];
  }
  return [];
}

export interface ClientInput {
  clientId: string;
  type: ClientType;
  redirectUris: readonly string[];
  postLogoutRedirectUris: readonly string[];
  scopes: readonly string[];
  accessTokenTtl?: number;
  refreshTokenTtl?: number;
  backchannelLogoutUri?: string | null;
  frontchannelLogoutUri?: string | null;
  branding?: unknown;
  mfeFeatures?: unknown;
  membershipSchema?: unknown;
}

/** Aggregates every problem with the payload; an empty array means the input is acceptable. */
export function clientInputProblems(
  input: ClientInput,
  options: { adminClientId: string },
): string[] {
  const problems: string[] = [
    ...uriListProblems(input.redirectUris, 'redirectUris'),
    ...uriListProblems(input.postLogoutRedirectUris, 'postLogoutRedirectUris'),
    ...scopeProblems({
      scopes: input.scopes,
      type: input.type,
      adminClientId: options.adminClientId,
      clientId: input.clientId,
    }),
    ...ttlProblems(input.accessTokenTtl, input.refreshTokenTtl),
    ...brandingProblems(input.branding),
    ...mfeFeatureProblems(input.mfeFeatures),
    ...membershipSchemaProblems(input.membershipSchema),
  ];

  if (input.type !== 'm2m' && input.redirectUris.length === 0) {
    problems.push('redirectUris: at least one redirect URI is required');
  }
  for (const field of ['backchannelLogoutUri', 'frontchannelLogoutUri'] as const) {
    const value = input[field];
    if (value === undefined || value === null) {
      continue;
    }
    const problem = uriProblem(value);
    if (problem !== null) {
      problems.push(`${field}: ${problem}`);
    }
  }
  return problems;
}
