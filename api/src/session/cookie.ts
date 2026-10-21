export const SESSION_COOKIE_NAME = 'idpn_session';

export interface SessionCookieOptions {
  /** Set `false` only for local http development. */
  secure: boolean;
  /** Cookie lifetime in seconds; mirror the session absolute TTL. */
  maxAgeSeconds: number;
  /** Cookie path; the IdP rotates it for every auth endpoint. */
  path?: string;
  domain?: string;
}

/**
 * Serializes the IdP session cookie.
 *
 * Hard requirements (docs/auth-flows.md 3, docs/security.md):
 * `HttpOnly` so JavaScript can never read it, `Secure` outside development and
 * `SameSite=Lax` so cross-site top-level redirects keep working while CSRF is bounded.
 */
export function serializeSessionCookie(sid: string, options: SessionCookieOptions): string {
  if (sid === '' || /[^\w.-]/.test(sid)) {
    throw new Error('Invalid session id for cookie serialization');
  }

  const parts = [
    `${SESSION_COOKIE_NAME}=${sid}`,
    `Path=${options.path ?? '/'}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  if (options.domain !== undefined && options.domain !== '') {
    parts.push(`Domain=${options.domain}`);
  }
  return parts.join('; ');
}

/** Expires the session cookie (logout, revocation, rotation). */
export function clearSessionCookie(
  options: Pick<SessionCookieOptions, 'secure' | 'path' | 'domain'>,
): string {
  return serializeSessionCookie('deleted', {
    secure: options.secure,
    maxAgeSeconds: 0,
    path: options.path,
    domain: options.domain,
  });
}

/** Emits the `Set-Cookie` header value, never a raw string that could be logged. */
export function sessionCookieHeader(
  sid: string,
  options: SessionCookieOptions,
): { 'Set-Cookie': string } {
  return { 'Set-Cookie': serializeSessionCookie(sid, options) };
}

/** Parses a `Cookie` request header into a lookup map (no dependency needed). */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (header === undefined || header === '') {
    return {};
  }
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name !== '') {
      // A malformed escape (`idpn_session=%`) must make the request anonymous, not throw a
      // URIError out of the session reader (card #70 finding 5).
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        continue;
      }
    }
  }
  return cookies;
}

/** Reads the IdP session id from a `Cookie` header, if present. */
export function readSessionId(header: string | undefined): string | null {
  const value = parseCookieHeader(header)[SESSION_COOKIE_NAME];
  return value === undefined || value === '' ? null : value;
}
