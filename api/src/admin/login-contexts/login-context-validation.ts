/**
 * Validation for login context administration (docs/api.md 3.3.3,
 * docs/login-contexts.md 3.1 and 6).
 *
 * The rules are kept pure so they can be unit tested and so the same checks run for
 * create and for the merged result of a PATCH (e.g. `defaultRoles ⊆ allowedRoles` must
 * still hold after a partial update).
 */

import { loginContextBrandingSchema } from '@idpn/contracts';

import {
  LOGIN_CONTEXT_MFA_POLICIES,
  LOGIN_CONTEXT_REGISTRATION_POLICIES,
  LOGIN_METHODS,
} from './login-context-types.js';

/** `key` is unique per client and used in URLs: lowercase, digits, inner dashes only. */
export const LOGIN_CONTEXT_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const MAX_LOGIN_CONTEXT_NAME = 120;
export const MAX_LOGIN_CONTEXT_DESCRIPTION = 500;
export const MAX_LOGIN_CONTEXT_ROLES = 50;
export const MAX_LOGIN_CONTEXT_DOMAINS = 50;
export const MAX_LOGIN_CONTEXT_BRANDING_BYTES = 8 * 1024;
export const MIN_SESSION_IDLE_TTL = 60;
export const MAX_SESSION_IDLE_TTL = 86_400;
export const MIN_SESSION_ABSOLUTE_TTL = 300;
export const MAX_SESSION_ABSOLUTE_TTL = 2_592_000;
export const MAX_SORT_ORDER = 100_000;

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Full context state after a create or after merging a PATCH into the stored row. */
export interface LoginContextValidationInput {
  key: string;
  name: string;
  description: string | null;
  allowedRoles: string[];
  defaultRoles: string[];
  loginMethods: string[];
  mfaPolicy: string;
  registrationPolicy: string;
  allowedEmailDomains: string[];
  sessionIdleTtl: number;
  sessionAbsoluteTtl: number;
  stepUpRequired: boolean;
  isDefault: boolean;
  branding: Record<string, unknown> | null;
  sortOrder: number;
}

export interface LoginContextValidationContext {
  clientId: string;
  /** Role keys owned by the client. Global (`idp:*`) roles must never be present here. */
  clientRoleKeys: ReadonlySet<string>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const duplicates = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      repeated.push(value);
    }
    seen.add(value);
  }
  return repeated;
};

export function loginContextKeyProblem(key: string): string | null {
  if (key === '') {
    return 'key: is required';
  }
  if (key.length > 64) {
    return 'key: must be at most 64 characters';
  }
  if (!LOGIN_CONTEXT_KEY_PATTERN.test(key)) {
    return 'key: must be lowercase letters, digits and inner dashes (e.g. customer-admin)';
  }
  return null;
}

/**
 * Validates `allowedRoles` / `defaultRoles`.
 *
 * A role is accepted only when the database says it belongs to the same client. A global
 * `idp:*` role would let an app context mint platform privileges, so it is rejected with
 * `422` even before the ownership lookup (docs/login-contexts.md 5 and 6).
 */
export function roleProblems(
  input: Pick<LoginContextValidationInput, 'allowedRoles' | 'defaultRoles'>,
  context: LoginContextValidationContext,
): string[] {
  const problems: string[] = [];
  const check = (field: 'allowedRoles' | 'defaultRoles', values: readonly string[]) => {
    if (values.length > MAX_LOGIN_CONTEXT_ROLES) {
      problems.push(`${field}: at most ${MAX_LOGIN_CONTEXT_ROLES} roles are allowed`);
    }
    for (const [index, role] of values.entries()) {
      if (role === '') {
        problems.push(`${field}[${index}]: is required`);
      } else if (role.startsWith('idp:')) {
        problems.push(
          `${field}[${index}]: global role "${role}" cannot be granted by a login context`,
        );
      } else if (!context.clientRoleKeys.has(role)) {
        problems.push(
          `${field}[${index}]: role "${role}" does not belong to client "${context.clientId}"`,
        );
      }
    }
    for (const repeated of new Set(duplicates(values))) {
      problems.push(`${field}: duplicate role "${repeated}"`);
    }
  };

  check('allowedRoles', input.allowedRoles);
  check('defaultRoles', input.defaultRoles);

  const allowed = new Set(input.allowedRoles);
  for (const [index, role] of input.defaultRoles.entries()) {
    if (role !== '' && !allowed.has(role)) {
      problems.push(`defaultRoles[${index}]: role "${role}" is not in allowedRoles`);
    }
  }

  return problems;
}

export function sessionTtlProblems(
  input: Pick<LoginContextValidationInput, 'sessionIdleTtl' | 'sessionAbsoluteTtl'>,
): string[] {
  const problems: string[] = [];
  if (
    !Number.isInteger(input.sessionIdleTtl) ||
    input.sessionIdleTtl < MIN_SESSION_IDLE_TTL ||
    input.sessionIdleTtl > MAX_SESSION_IDLE_TTL
  ) {
    problems.push(
      `sessionIdleTtl: must be an integer between ${MIN_SESSION_IDLE_TTL} and ${MAX_SESSION_IDLE_TTL} seconds`,
    );
  }
  if (
    !Number.isInteger(input.sessionAbsoluteTtl) ||
    input.sessionAbsoluteTtl < MIN_SESSION_ABSOLUTE_TTL ||
    input.sessionAbsoluteTtl > MAX_SESSION_ABSOLUTE_TTL
  ) {
    problems.push(
      `sessionAbsoluteTtl: must be an integer between ${MIN_SESSION_ABSOLUTE_TTL} and ${MAX_SESSION_ABSOLUTE_TTL} seconds`,
    );
  }
  if (
    Number.isInteger(input.sessionIdleTtl) &&
    Number.isInteger(input.sessionAbsoluteTtl) &&
    input.sessionAbsoluteTtl < input.sessionIdleTtl
  ) {
    problems.push('sessionAbsoluteTtl: must be greater than or equal to sessionIdleTtl');
  }
  return problems;
}

/**
 * Validates context `branding` at write time (docs/login-contexts.md 7.1).
 *
 * The public config already sanitizes what it publishes, but a row that is only safe
 * downstream can still be read by another consumer (export, future UI, a second service).
 * The shared contract therefore decides here: a plain-text `title`, an `http(s)` `logoUrl`
 * and theme tokens, with unknown keys rejected so a stored `url(...)` or raw CSS can never
 * appear.
 */
export function brandingProblems(branding: Record<string, unknown> | null): string[] {
  if (branding === null) {
    return [];
  }
  if (!isPlainObject(branding)) {
    return ['branding: must be an object'];
  }
  if (
    Buffer.byteLength(JSON.stringify(branding), 'utf8') > MAX_LOGIN_CONTEXT_BRANDING_BYTES
  ) {
    return [
      `branding: must be at most ${MAX_LOGIN_CONTEXT_BRANDING_BYTES} bytes when serialized`,
    ];
  }
  const parsed = loginContextBrandingSchema.safeParse(branding);
  if (parsed.success) {
    return [];
  }
  return parsed.error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join('.');
    return path === '' ? `branding: ${issue.message}` : `branding.${path}: ${issue.message}`;
  });
}

/** Every documented rule that does not need a database lookup beyond the client's roles. */
export function loginContextInputProblems(
  input: LoginContextValidationInput,
  context: LoginContextValidationContext,
): string[] {
  const problems: string[] = [];

  const keyProblem = loginContextKeyProblem(input.key);
  if (keyProblem !== null) {
    problems.push(keyProblem);
  }

  if (input.name.trim() === '') {
    problems.push('name: is required');
  } else if (input.name.length > MAX_LOGIN_CONTEXT_NAME) {
    problems.push(`name: must be at most ${MAX_LOGIN_CONTEXT_NAME} characters`);
  }

  if (input.description !== null) {
    if (input.description.length > MAX_LOGIN_CONTEXT_DESCRIPTION) {
      problems.push(`description: must be at most ${MAX_LOGIN_CONTEXT_DESCRIPTION} characters`);
    }
  }

  problems.push(...roleProblems(input, context));

  if (input.loginMethods.length === 0) {
    problems.push('loginMethods: at least one method is required');
  }
  for (const [index, method] of input.loginMethods.entries()) {
    if (!(LOGIN_METHODS as readonly string[]).includes(method)) {
      problems.push(
        `loginMethods[${index}]: unsupported method "${method}" (allowed: ${LOGIN_METHODS.join(', ')})`,
      );
    }
  }
  for (const repeated of new Set(duplicates(input.loginMethods))) {
    problems.push(`loginMethods: duplicate method "${repeated}"`);
  }

  if (!(LOGIN_CONTEXT_MFA_POLICIES as readonly string[]).includes(input.mfaPolicy)) {
    problems.push(`mfaPolicy: must be one of ${LOGIN_CONTEXT_MFA_POLICIES.join(', ')}`);
  }

  if (
    !(LOGIN_CONTEXT_REGISTRATION_POLICIES as readonly string[]).includes(input.registrationPolicy)
  ) {
    problems.push(
      `registrationPolicy: must be one of ${LOGIN_CONTEXT_REGISTRATION_POLICIES.join(', ')}`,
    );
  }

  if (input.allowedEmailDomains.length > MAX_LOGIN_CONTEXT_DOMAINS) {
    problems.push(`allowedEmailDomains: at most ${MAX_LOGIN_CONTEXT_DOMAINS} domains are allowed`);
  }
  for (const [index, domain] of input.allowedEmailDomains.entries()) {
    if (!DOMAIN_PATTERN.test(domain)) {
      problems.push(`allowedEmailDomains[${index}]: must be a domain name such as example.com`);
    }
  }
  for (const repeated of new Set(duplicates(input.allowedEmailDomains))) {
    problems.push(`allowedEmailDomains: duplicate domain "${repeated}"`);
  }

  problems.push(...sessionTtlProblems(input));

  problems.push(...brandingProblems(input.branding));

  if (
    !Number.isInteger(input.sortOrder) ||
    input.sortOrder < 0 ||
    input.sortOrder > MAX_SORT_ORDER
  ) {
    problems.push(`sortOrder: must be an integer between 0 and ${MAX_SORT_ORDER}`);
  }

  return problems;
}
