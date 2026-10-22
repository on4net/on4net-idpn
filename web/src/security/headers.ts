/**
 * Security headers for the Hosted Auth UI, the Module Federation host and the MFE remote
 * (docs/security.md 7, docs/micro-frontend.md 12).
 *
 * This module is the single source of truth for both the Vite dev/preview servers and the
 * deployment examples in `deploy/security/`. It deliberately has no Node or DOM imports so
 * the policy can be unit-tested in jsdom and reused from `vite.*.config.ts`.
 *
 * Trusted Types: enforcement (`require-trusted-types-for 'script'`) is opt-in through
 * `trustedTypesReportOnly` while the MFE and its federated runtime are validated; the
 * documented production policy turns it into a blocking directive after a clean report
 * window. SRI is not usable for a Module Federation remoteEntry that loads further chunks
 * at runtime, so the remote is pinned by origin + immutable version instead
 * (docs/mfe-security.md).
 */

export type SecurityProfile = 'hosted' | 'host' | 'remote';

export interface SecurityHeaderOptions {
  profile: SecurityProfile;
  /** Dev servers need Vite's inline preamble/HMR sockets; production must not. */
  dev?: boolean;
  /** API/IdP origins the document may call (connect-src). */
  idpOrigins?: readonly string[];
  /** Trusted CDN origins that serve `remoteEntry.js` and its chunks. */
  remoteOrigins?: readonly string[];
  /** Sends a report-only Trusted Types policy; never blocks. */
  trustedTypesReportOnly?: boolean;
}

const unique = (values: readonly (string | undefined)[]): string[] => [
  ...new Set(values.filter((value): value is string => value !== undefined && value !== '')),
];

const scriptSources = (options: SecurityHeaderOptions): string[] => {
  const base = options.dev ? ["'self'", "'unsafe-inline'"] : ["'self'"];
  if (options.profile === 'host') {
    return unique([...base, ...(options.remoteOrigins ?? [])]);
  }
  return base;
};

const connectSources = (options: SecurityHeaderOptions): string[] =>
  unique([
    "'self'",
    ...(options.idpOrigins ?? []),
    ...(options.profile === 'host' ? (options.remoteOrigins ?? []) : []),
    ...(options.dev ? ['ws:', 'wss:'] : []),
  ]);

/** Builds the CSP for a profile. Never emits `unsafe-eval` or a wildcard source. */
export function contentSecurityPolicy(options: SecurityHeaderOptions): string {
  const dev = options.dev === true;
  /**
   * Per-client context logos are cross-origin images from the client's own asset host
   * (`ClientLoginContext.branding.logoUrl`), so the Hosted UI admits `https:` images only —
   * never `http:` and never a script/style source (card #63 finding 2).
   */
  const imageSources = ["'self'", 'data:', ...(dev ? [] : ['https:'])];
  if (options.profile === 'remote') {
    // The response is imported as a module by the host document, so this policy only applies
    // if the file is navigated to directly; keep it strict anyway.
    return [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ].join('; ');
  }

  const directives = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    // The Hosted UI must never be framed (clickjacking, T16 in docs/security.md).
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${scriptSources(options).join(' ')}`,
    // React/Radix set inline style attributes; a stylesheet nonce is not viable for a
    // source-copied shadcn/Tailwind build, so inline *styles* stay allowed.
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imageSources.join(' ')}`,
    "font-src 'self' data:",
    `connect-src ${connectSources(options).join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];
  if (!dev) {
    directives.push('upgrade-insecure-requests');
  }
  return directives.join('; ');
}

const baseHeaders = (): Record<string, string> => ({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

/**
 * Returns the full header set for a server. `Access-Control-Allow-Origin` is intentionally
 * absent: the remote server decides it per request from the origin allowlist
 * (`decideCors`), never with `*`.
 */
export function buildSecurityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    ...baseHeaders(),
    'Content-Security-Policy': contentSecurityPolicy(options),
  };

  if (options.profile === 'remote') {
    // Required so the host document can import this cross-origin ES module.
    headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
  } else {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Resource-Policy'] = 'same-origin';
  }

  if (options.trustedTypesReportOnly === true) {
    headers['Content-Security-Policy-Report-Only'] =
      "require-trusted-types-for 'script'; trusted-types idpn 'allow-duplicates'";
  }

  return headers;
}

export interface CorsDecision {
  /** True when the request may read the response cross-origin. */
  allowed: boolean;
  headers: Record<string, string>;
}

/**
 * Origin allowlist for `remoteEntry.js` and its chunks. A request without `Origin`
 * (same-origin navigation, curl) is allowed; any other origin must match exactly.
 */
export function decideCors(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): CorsDecision {
  if (origin === undefined || origin === '') {
    return { allowed: true, headers: {} };
  }
  if (!allowedOrigins.includes(origin)) {
    return { allowed: false, headers: { Vary: 'Origin' } };
  }
  return {
    allowed: true,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
  };
}
