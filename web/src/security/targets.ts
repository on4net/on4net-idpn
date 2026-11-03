/**
 * Shared URL rules for host and MFE configuration (docs/micro-frontend.md 5 and 12,
 * docs/security.md 7).
 *
 * The same predicate guards the `api-base` attribute of the custom element and the redirect
 * targets of the host config, because both end up as a request target. A browser normalises
 * `\\` to `/`, so `/\evil.example.com` and `\\evil.example.com` are protocol-relative URLs
 * even though they do not start with `//`: a single backslash is enough to escape the origin.
 * Pure module, no DOM or Node imports, so it can be unit tested and used from a Vite config.
 */

/** A backslash or whitespace anywhere makes the value ambiguous for the URL parser. */
const UNSAFE_CHARACTER = /[\s\\]/;

/**
 * True for a same-origin path (`/auth`, but not `//host` or `/\host`) or an absolute
 * `http(s)` URL with a host. Everything else - `javascript:`, `data:`, a bare relative
 * segment or a protocol-relative target - is rejected.
 */
export function isSafeTarget(value: string): boolean {
  if (value === '' || UNSAFE_CHARACTER.test(value)) {
    return false;
  }
  if (value.startsWith('/')) {
    return !value.startsWith('//');
  }
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '';
  } catch {
    return false;
  }
}

export interface RemoteEntryTarget {
  /** Entry passed to Module Federation: a same-origin path or an absolute URL. */
  entry: string;
  /** Origins the host CSP must allow for `script-src`/`connect-src`. */
  origins: string[];
}

/** Entry used when `IDPN_REMOTE_ENTRY` is unset: the same-origin copy served by the host. */
export const DEFAULT_REMOTE_ENTRY = '/remote/remoteEntry.js';

/**
 * Validates the remote entry of the Module Federation host.
 *
 * An absolute entry may only point at an origin the operator explicitly allowlisted, so a
 * stray environment value cannot load third-party code into the host origin; a same-origin
 * path is accepted as-is. Anything else fails at config time instead of at runtime.
 */
export function resolveRemoteEntry(
  value: string | undefined,
  allowedOrigins: readonly string[] = [],
): RemoteEntryTarget {
  const entry = value === undefined || value.trim() === '' ? DEFAULT_REMOTE_ENTRY : value.trim();
  if (!isSafeTarget(entry)) {
    throw new Error(
      'IDPN_REMOTE_ENTRY must be an https URL or a same-origin path starting with a single /',
    );
  }
  if (entry.startsWith('/')) {
    return { entry, origins: [] };
  }

  const url = new URL(entry);
  if (url.protocol !== 'https:') {
    throw new Error('IDPN_REMOTE_ENTRY must use https');
  }
  const allowed = new Set(allowedOrigins.map((origin) => origin.trim()).filter(Boolean));
  if (!allowed.has(url.origin)) {
    throw new Error(
      `IDPN_REMOTE_ENTRY origin ${url.origin} is not in IDPN_REMOTE_ORIGINS; declare the CDN origin you trust`,
    );
  }
  // Pin the version the way the deployment documents it: `/idpn-mfe/<version>/remoteEntry.js`.
  return { entry, origins: [url.origin] };
}
