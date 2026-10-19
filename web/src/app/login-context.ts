import { sanitizeIdpnTheme, type IdpnTheme } from '@idpn/contracts/theme';

/**
 * Context selection model of the Hosted Auth UI (`docs/login-contexts.md` 4.2 and 7.1).
 *
 * The public config is untrusted browser input: every context is re-validated here before it
 * reaches the page. Only contexts the API published (already filtered to `active`) can be
 * selected, and the selection is only a *hint* for `/authorize`: the server re-validates the
 * context against the client, keeps it out of user input and re-checks membership.
 */

export const LOGIN_METHODS = ['password', 'google', 'facebook', 'otp', 'sso'] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export const MFA_POLICIES = ['optional', 'required_admins', 'required_all'] as const;
export type LoginContextMfaPolicy = (typeof MFA_POLICIES)[number];

export const REGISTRATION_POLICIES = ['invite_only', 'self_service', 'disabled'] as const;
export type LoginContextRegistrationPolicy = (typeof REGISTRATION_POLICIES)[number];

export interface LoginContextBranding {
  title?: string;
  logoUrl?: string;
  /** Sanitized tokens only; the page never emits CSS from this value. */
  theme?: IdpnTheme;
}

export interface LoginContextSummary {
  key: string;
  name: string;
  description?: string;
  methods: LoginMethod[];
  mfaPolicy: LoginContextMfaPolicy;
  registrationPolicy?: LoginContextRegistrationPolicy;
  branding?: LoginContextBranding;
}

const MAX_KEY_LENGTH = 64;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TITLE_LENGTH = 120;
const MAX_LOGO_URL_LENGTH = 2048;

/** Newlines/tabs in visible text would corrupt the layout; such values are dropped. */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > maxLength || hasControlCharacters(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** `http(s)` only: a `javascript:`/`data:` logo URL is never rendered. */
function logoUrl(value: unknown): string | undefined {
  const candidate = text(value, MAX_LOGO_URL_LENGTH);
  if (candidate === undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function branding(value: unknown): LoginContextBranding | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const title = text(source['title'], MAX_TITLE_LENGTH);
  const url = logoUrl(source['logoUrl']);
  const theme = sanitizeIdpnTheme(source['theme']);
  const resolved: LoginContextBranding = {
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? {} : { logoUrl: url }),
    ...(Object.keys(theme).length === 0 ? {} : { theme }),
  };
  return Object.keys(resolved).length === 0 ? undefined : resolved;
}

/**
 * Keeps the contexts that can actually be offered: a key, at least one known login method
 * and a known MFA policy. Duplicate keys keep the first entry (the API already sorts by
 * `sort_order`). A context without a name falls back to its key so the selector always has
 * an accessible label.
 */
export function sanitizeLoginContexts(input: unknown): LoginContextSummary[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const contexts: LoginContextSummary[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const source = entry as Record<string, unknown>;
    const key = text(source['key'], MAX_KEY_LENGTH);
    if (key === undefined || seen.has(key)) {
      continue;
    }
    const methods = Array.isArray(source['methods'])
      ? source['methods'].filter((method): method is LoginMethod =>
          (LOGIN_METHODS as readonly string[]).includes(method as string),
        )
      : [];
    const uniqueMethods = [...new Set(methods)];
    if (uniqueMethods.length === 0) {
      continue;
    }
    seen.add(key);
    const name = text(source['name'], MAX_NAME_LENGTH) ?? key;
    const description = text(source['description'], MAX_DESCRIPTION_LENGTH);
    const registrationPolicy = enumValue(source['registrationPolicy'], REGISTRATION_POLICIES);
    const presentation = branding(source['branding']);
    contexts.push({
      key,
      name,
      ...(description === undefined ? {} : { description }),
      methods: uniqueMethods,
      mfaPolicy: enumValue(source['mfaPolicy'], MFA_POLICIES) ?? 'optional',
      ...(registrationPolicy === undefined ? {} : { registrationPolicy }),
      ...(presentation === undefined ? {} : { branding: presentation }),
    });
  }
  return contexts;
}

export interface ResolveLoginContextInput {
  contexts: readonly LoginContextSummary[];
  /** `login_context` from the authorize redirect: the app already chose a context. */
  requestedKey?: string | undefined;
  /** In-page choice of this visit; keeps the selector visible so the user can switch again. */
  selectedKey?: string | undefined;
  /** `defaultLoginContext` from the public config (`is_default` on the server). */
  defaultKey?: string | undefined;
}

export interface ResolvedLoginContext {
  /** Context the page represents; `undefined` when the client publishes no context. */
  context?: LoginContextSummary;
  /** More than one context and the app did not pin one: show the selector. */
  requiresSelection: boolean;
  /** The requested key is unknown or no longer active; it is never honoured. */
  invalidRequested: boolean;
}

/**
 * Resolution order: explicit request (server redirect) -> in-page selection -> default
 * context -> first published context. A single-context client never shows a selector
 * (docs/login-contexts.md 4.2), but its context still brands the page and is bound to the
 * login request so the issued token carries `login_context`.
 */
export function resolveLoginContext(input: ResolveLoginContextInput): ResolvedLoginContext {
  const contexts = input.contexts;
  if (contexts.length === 0) {
    return { requiresSelection: false, invalidRequested: false };
  }

  const requested = text(input.requestedKey, MAX_KEY_LENGTH);
  if (requested !== undefined) {
    const match = contexts.find((candidate) => candidate.key === requested);
    if (match !== undefined) {
      return { context: match, requiresSelection: false, invalidRequested: false };
    }
  }

  const selected = text(input.selectedKey, MAX_KEY_LENGTH);
  const selectedContext =
    selected === undefined ? undefined : contexts.find((candidate) => candidate.key === selected);
  const defaultKey = text(input.defaultKey, MAX_KEY_LENGTH);
  const defaultContext =
    defaultKey === undefined
      ? undefined
      : contexts.find((candidate) => candidate.key === defaultKey);
  const context = selectedContext ?? defaultContext ?? contexts[0];

  return {
    ...(context === undefined ? {} : { context }),
    requiresSelection: contexts.length > 1,
    invalidRequested: requested !== undefined,
  };
}

/**
 * Rewrites only the `/oauth2/authorize` URL so the issued code is bound to the selected
 * context. Every other parameter (`state`, `nonce`, `code_challenge`, `login_hint`, scope)
 * is preserved byte for byte; relative and absolute authorize URLs are both supported.
 * Anything that is not the authorize endpoint (for example a plain `redirect_uri`) is left
 * untouched.
 */
export function withLoginContext(
  returnTo: string | undefined,
  contextKey: string | undefined,
): string | undefined {
  if (returnTo === undefined || contextKey === undefined || contextKey.trim() === '') {
    return returnTo;
  }
  const base =
    typeof window === 'undefined' || window.location.origin === 'null'
      ? 'http://localhost'
      : window.location.origin;
  try {
    const url = new URL(returnTo, base);
    if (!url.pathname.endsWith('/oauth2/authorize')) {
      return returnTo;
    }
    url.searchParams.set('login_context', contextKey);
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(returnTo)
      ? url.toString()
      : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return returnTo;
  }
}

export interface ContextPresentation {
  title: string;
  logoUrl?: string;
  description?: string;
}

/**
 * Branded header of the selected context. `null` means "no context chrome": a context
 * without a title, logo or description keeps the plain client login card, so existing
 * single-context clients are visually unchanged.
 */
export function contextPresentation(
  context: LoginContextSummary | undefined,
): ContextPresentation | null {
  if (context === undefined) {
    return null;
  }
  const title = context.branding?.title;
  const url = context.branding?.logoUrl;
  const description = context.description;
  if (title === undefined && url === undefined && description === undefined) {
    return null;
  }
  return {
    title: title ?? context.name,
    ...(url === undefined ? {} : { logoUrl: url }),
    ...(description === undefined ? {} : { description }),
  };
}

/** Login methods a context allows; the password form is hidden when it is not listed. */
export function contextAllowsPassword(context: LoginContextSummary | undefined): boolean {
  return context === undefined || context.methods.includes('password');
}

/**
 * Message keys describing the context policy. The UI only *explains* the policy; the API
 * enforces it at `/api/v1/login` (MFA) and `/authorize` (context + membership).
 */
export function contextPolicyKeys(context: LoginContextSummary | undefined): string[] {
  if (context === undefined) {
    return [];
  }
  const keys: string[] = [];
  if (context.mfaPolicy === 'required_all') {
    keys.push('login.context.mfaRequiredAll');
  } else if (context.mfaPolicy === 'required_admins') {
    keys.push('login.context.mfaRequiredAdmins');
  }
  if (context.registrationPolicy === 'invite_only') {
    keys.push('login.context.registrationInviteOnly');
  } else if (context.registrationPolicy === 'self_service') {
    keys.push('login.context.registrationSelfService');
  } else if (context.registrationPolicy === 'disabled') {
    keys.push('login.context.registrationDisabled');
  }
  return keys;
}
