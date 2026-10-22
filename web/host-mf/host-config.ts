import {
  IDPN_THEME_COLOR_KEYS,
  idpnThemeSchema,
  sanitizeIdpnTheme,
} from '@idpn/contracts/theme';
import { z } from 'zod';
import { isSafeTarget as safeTarget } from '../src/security/targets.ts';
import type {
  IdpnDirection,
  IdpnEventHandler,
  IdpnMfeMode,
  IdpnMfeModule,
  IdpnReactModuleProps,
  IdpnThemeTokens,
} from '@idpn/mfe-sdk';

/**
 * Typed configuration of the Module Federation host (docs/micro-frontend.md 5 and
 * docs/mfe-sdk.md 4).
 *
 * The configuration is read once at bootstrap from the host's build-time environment
 * (`VITE_IDPN_*`). It is never derived from the URL, a query string, form input or any
 * other user-controlled value: `clientId` scopes every API call, so letting a browser
 * user choose it would break the tenant boundary.
 */

export const DEFAULT_LOCALE = 'fa-IR';
/** Hosted fallback target used when the remote cannot be loaded. */
export const DEFAULT_LOGIN_URL = '/oauth2/authorize';
export const DEFAULT_LOGIN_CONTEXT = 'default';

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const LOGIN_CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Redirect targets and API bases must be an absolute http(s) URL or a same-origin path.
 * Protocol-relative `//host`, `/\host` (a browser reads the backslash as `/`) and
 * `javascript:` values are rejected so config cannot be turned into an open redirect.
 */
const isSafeTarget = (value: string): boolean => safeTarget(value);

export type HostModuleSelection = IdpnMfeModule | 'all';

export type HostEnvSource = Readonly<Record<string, string | undefined>>;

export interface HostConfigIssue {
  /** Environment key that is missing or invalid; the value itself is never reported. */
  readonly key: string;
  readonly message: string;
}

export class HostConfigError extends Error {
  override readonly name = 'HostConfigError';
  readonly issues: readonly HostConfigIssue[];

  constructor(issues: readonly HostConfigIssue[]) {
    super(
      [
        'Invalid IDPN host configuration:',
        ...issues.map((issue) => `  - ${issue.key}: ${issue.message}`),
        'Set the VITE_IDPN_* variables described in docs/mfe-sdk.md.',
      ].join('\n'),
    );
    this.issues = issues;
  }
}

export interface IdpnHostConfig {
  /** Public client id of this application; host configuration, never user input. */
  readonly clientId: string;
  /** `bff` (default, cookie session) or `spa` (trusted hosts, in-memory token only). */
  readonly mode: IdpnMfeMode;
  /** BFF `/auth` prefix; empty means same-origin. */
  readonly apiBaseUrl: string;
  /** Hosted Auth UI page used as the documented fallback when a remote fails. */
  readonly loginUrl: string;
  /** Active login context of the host route; display only, authorization is server-side. */
  readonly loginContext: string;
  readonly locale: string;
  readonly dir: IdpnDirection;
  readonly modules: readonly IdpnMfeModule[];
  readonly theme: IdpnThemeTokens;
}

export const MODULE_LABEL: Record<IdpnMfeModule, string> = {
  'user-management': 'User management',
  account: 'Account',
};

const MODULE_SELECTION: Record<HostModuleSelection, readonly IdpnMfeModule[]> = {
  all: ['user-management', 'account'],
  'user-management': ['user-management'],
  account: ['account'],
};

const RTL_LANGUAGES = new Set(['ar', 'ckb', 'fa', 'he', 'ps', 'ur', 'yi']);

export function directionOf(locale: string): IdpnDirection {
  const language = locale.split('-')[0]?.toLowerCase() ?? '';
  return RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
}

const lowerCase = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Empty `KEY=` entries in an env file behave like an unset key. */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const hostConfigSchema = z.object({
  VITE_IDPN_CLIENT_ID: z
    .string()
    .trim()
    .min(1, 'is required')
    .max(64, 'must be at most 64 characters')
    .regex(CLIENT_ID_PATTERN, 'must be a public client id such as app-a'),
  VITE_IDPN_MODE: z.preprocess(
    (value) => lowerCase(emptyToUndefined(value)),
    z.enum(['bff', 'spa']).default('bff'),
  ),
  VITE_IDPN_API_BASE_URL: z
    .string()
    .trim()
    .default('')
    .refine(
      (value) => value === '' || isSafeTarget(value),
      'must be empty (same-origin), an http(s) URL, or a path starting with a single /',
    ),
  VITE_IDPN_LOGIN_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .refine(isSafeTarget, 'must be an http(s) URL or a path starting with a single /')
      .default(DEFAULT_LOGIN_URL),
  ),
  VITE_IDPN_LOGIN_CONTEXT: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .regex(LOGIN_CONTEXT_PATTERN, 'must be a login context key such as default or admin')
      .default(DEFAULT_LOGIN_CONTEXT),
  ),
  VITE_IDPN_LOCALE: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .regex(LOCALE_PATTERN, 'must be a BCP 47 locale such as fa-IR or en-US')
      .default(DEFAULT_LOCALE),
  ),
  VITE_IDPN_DIR: z.preprocess(
    (value) => lowerCase(emptyToUndefined(value)),
    z.enum(['auto', 'rtl', 'ltr']).default('auto'),
  ),
  VITE_IDPN_MODULE: z.preprocess(
    (value) => lowerCase(emptyToUndefined(value)),
    z.enum(['all', 'user-management', 'account']).default('all'),
  ),
  VITE_IDPN_THEME: z.string().trim().optional(),
});

type ParsedHostConfig = z.infer<typeof hostConfigSchema>;

type ThemeResult =
  | { readonly ok: true; readonly tokens: IdpnThemeTokens }
  | { readonly ok: false; readonly issue: HostConfigIssue };

const THEME_ISSUE: HostConfigIssue = {
  key: 'VITE_IDPN_THEME',
  message: 'must be a JSON object whose values are CSS token strings',
};

/** Keys the theme contract accepts; anything else is a host configuration mistake. */
const THEME_KEYS = new Set<string>([...IDPN_THEME_COLOR_KEYS, 'radius', 'fontFamily', 'dark']);

/**
 * Validates `VITE_IDPN_THEME` against the shared theme contract (`docs/mfe-sdk.md` 8).
 *
 * The host used to accept arbitrary token names and pass them on, but the contract has a
 * closed `IdpnTheme` shape since v2: an unknown key such as the old `{ "brand": "#0057b8" }`
 * would be dropped at render time and the host would boot unthemed without any signal. It is
 * rejected here instead.
 */
function parseThemeTokens(raw: string | undefined): ThemeResult {
  if (raw === undefined || raw === '') {
    return { ok: true, tokens: {} };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, issue: THEME_ISSUE };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issue: THEME_ISSUE };
  }

  for (const name of Object.keys(value)) {
    if (!THEME_KEYS.has(name)) {
      return {
        ok: false,
        issue: {
          key: THEME_ISSUE.key,
          message: `token "${name}" is not part of the theme contract`,
        },
      };
    }
  }

  const parsed = idpnThemeSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issue: { key: THEME_ISSUE.key, message: 'must contain valid CSS colour and radius values' },
    };
  }
  // The schema allows extra keys for client rows; the effective theme is the sanitized one
  // (grammar + WCAG AA contrast, see `sanitizeIdpnTheme`).
  return { ok: true, tokens: sanitizeIdpnTheme(parsed.data) };
}

function describeIssue(issue: { readonly code: string; readonly message: string }): string {
  return issue.code === 'invalid_type' ? 'is required' : issue.message;
}

/**
 * Validates the host environment and returns the immutable host configuration.
 *
 * @throws {HostConfigError} when one or more keys are missing or invalid. The message lists
 * the offending keys only, never their values.
 */
export function parseHostConfig(source: HostEnvSource): IdpnHostConfig {
  const parsed = hostConfigSchema.safeParse(source);
  const issues: HostConfigIssue[] = [];
  let data: ParsedHostConfig | null = null;
  let theme: IdpnThemeTokens = {};

  if (parsed.success) {
    data = parsed.data;
    const themeResult = parseThemeTokens(data.VITE_IDPN_THEME);
    if (themeResult.ok) {
      theme = themeResult.tokens;
    } else {
      issues.push(themeResult.issue);
    }
  } else {
    for (const issue of parsed.error.issues) {
      const key = issue.path.length > 0 ? String(issue.path[0]) : '(root)';
      issues.push({ key, message: describeIssue(issue) });
    }
  }

  if (data === null || issues.length > 0) {
    throw new HostConfigError(issues);
  }

  return {
    clientId: data.VITE_IDPN_CLIENT_ID,
    mode: data.VITE_IDPN_MODE,
    apiBaseUrl: data.VITE_IDPN_API_BASE_URL,
    loginUrl: data.VITE_IDPN_LOGIN_URL,
    loginContext: data.VITE_IDPN_LOGIN_CONTEXT,
    locale: data.VITE_IDPN_LOCALE,
    dir: data.VITE_IDPN_DIR === 'auto' ? directionOf(data.VITE_IDPN_LOCALE) : data.VITE_IDPN_DIR,
    modules: MODULE_SELECTION[data.VITE_IDPN_MODULE],
    theme,
  };
}

export interface ModulePropOptions {
  readonly onEvent?: IdpnEventHandler;
  /** SPA mode only: getter over a token held in memory by the host. */
  readonly getAccessToken?: () => string | null;
}

/**
 * Builds the props forwarded to a remote module.
 *
 * The token getter is attached only in `spa` mode; in the default `bff` mode the remote
 * authenticates with the host's `HttpOnly` session cookie and no token ever reaches the
 * browser bundle.
 */
export function toModuleProps(
  config: IdpnHostConfig,
  options: ModulePropOptions = {},
): IdpnReactModuleProps {
  const getAccessToken = config.mode === 'spa' ? options.getAccessToken : undefined;
  return {
    clientId: config.clientId,
    locale: config.locale,
    dir: config.dir,
    theme: config.theme,
    ...(config.apiBaseUrl === '' ? {} : { apiBaseUrl: config.apiBaseUrl }),
    ...(getAccessToken === undefined ? {} : { getAccessToken }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  };
}
