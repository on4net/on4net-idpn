import { describe, expect, it } from 'vitest';

import {
  clearSessionCookie,
  parseCookieHeader,
  readSessionId,
  SESSION_COOKIE_NAME,
  serializeSessionCookie,
  sessionCookieHeader,
} from './cookie.js';

const sid = '6f1a1c2e-1c7b-4c31-9c55-2c1f0f1f1f1f';

describe('session cookie', () => {
  it('is HttpOnly, SameSite=Lax and Secure in production', () => {
    const cookie = serializeSessionCookie(sid, { secure: true, maxAgeSeconds: 28_800 });

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=28800');
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=${sid}`)).toBe(true);
  });

  it('omits Secure only when explicitly disabled for local development', () => {
    const cookie = serializeSessionCookie(sid, { secure: false, maxAgeSeconds: 60 });
    expect(cookie).not.toContain('Secure');
  });

  it('rejects a session id with characters that could break the header', () => {
    expect(() =>
      serializeSessionCookie('bad; Domain=evil', { secure: true, maxAgeSeconds: 1 }),
    ).toThrow();
    expect(() => serializeSessionCookie('', { secure: true, maxAgeSeconds: 1 })).toThrow();
  });

  it('clears the cookie with Max-Age=0 and the same attributes', () => {
    const cookie = clearSessionCookie({ secure: true, path: '/' });

    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('builds a Set-Cookie header object', () => {
    const header = sessionCookieHeader(sid, { secure: true, maxAgeSeconds: 10 });
    expect(Object.keys(header)).toEqual(['Set-Cookie']);
    expect(header['Set-Cookie']).toContain('HttpOnly');
  });
});

describe('cookie parsing', () => {
  it('parses the idpn_session cookie among others', () => {
    const header = `theme=dark; ${SESSION_COOKIE_NAME}=${sid}; locale=fa-IR`;
    expect(readSessionId(header)).toBe(sid);
  });

  it('returns null when the cookie is missing or empty', () => {
    expect(readSessionId(undefined)).toBeNull();
    expect(readSessionId('theme=dark')).toBeNull();
    expect(readSessionId(`${SESSION_COOKIE_NAME}=`)).toBeNull();
  });

  it('decodes URI-encoded values and ignores malformed pairs', () => {
    expect(parseCookieHeader('a=1; broken; b=hello%20world')).toEqual({ a: '1', b: 'hello world' });
  });
});
