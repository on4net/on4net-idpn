import { describe, expect, it } from 'vitest';

import { buildSecurityHeaders, contentSecurityPolicy, decideCors } from './headers';
import { parseOrigins } from './remote-cors';

const directive = (policy: string, name: string): string | undefined =>
  policy
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name} `));

describe('security headers', () => {
  it('locks the Hosted UI down without eval or framing', () => {
    const policy = contentSecurityPolicy({
      profile: 'hosted',
      dev: false,
      idpOrigins: ['https://auth.example.com'],
    });

    expect(directive(policy, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(policy, 'script-src')).toBe("script-src 'self'");
    expect(directive(policy, 'object-src')).toBe("object-src 'none'");
    expect(directive(policy, 'base-uri')).toBe("base-uri 'none'");
    expect(directive(policy, 'connect-src')).toContain('https://auth.example.com');
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('*');
    expect(policy).toContain('upgrade-insecure-requests');
  });

  it('only relaxes script-src and websockets in the dev server', () => {
    const policy = contentSecurityPolicy({ profile: 'hosted', dev: true });

    expect(directive(policy, 'script-src')).toBe("script-src 'self' 'unsafe-inline'");
    expect(directive(policy, 'connect-src')).toContain('ws:');
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('upgrade-insecure-requests');
  });

  it('allowlists the remote CDN origin for a Module Federation host', () => {
    const policy = contentSecurityPolicy({
      profile: 'host',
      dev: false,
      idpOrigins: ['https://auth.example.com'],
      remoteOrigins: ['https://cdn.example.com'],
    });

    expect(directive(policy, 'script-src')).toBe("script-src 'self' https://cdn.example.com");
    expect(directive(policy, 'connect-src')).toContain('https://cdn.example.com');
    expect(directive(policy, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  it('marks the remote as cross-origin readable but never wildcard CORS', () => {
    const headers = buildSecurityHeaders({ profile: 'remote', dev: false });

    expect(headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers).not.toHaveProperty('Access-Control-Allow-Origin');
  });

  it('sends Trusted Types as report-only until enforcement is enabled', () => {
    const reportOnly = buildSecurityHeaders({
      profile: 'hosted',
      dev: false,
      trustedTypesReportOnly: true,
    });
    const enforced = buildSecurityHeaders({ profile: 'hosted', dev: false });

    expect(reportOnly['Content-Security-Policy-Report-Only']).toContain(
      "require-trusted-types-for 'script'",
    );
    expect(reportOnly['Content-Security-Policy']).not.toContain('trusted-types');
    expect(enforced).not.toHaveProperty('Content-Security-Policy-Report-Only');
  });
});

describe('remote origin allowlist', () => {
  const allowed = ['https://app.example.com'];

  it('echoes an allowlisted origin instead of *', () => {
    const decision = decideCors('https://app.example.com', allowed);

    expect(decision.allowed).toBe(true);
    expect(decision.headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(decision.headers['Access-Control-Allow-Origin']).not.toBe('*');
    expect(decision.headers.Vary).toBe('Origin');
  });

  it('rejects an unknown origin and a missing configuration', () => {
    expect(decideCors('https://evil.example.com', allowed).allowed).toBe(false);
    expect(decideCors('https://evil.example.com', []).allowed).toBe(false);
  });

  it('allows same-origin requests without an Origin header', () => {
    expect(decideCors(undefined, allowed)).toEqual({ allowed: true, headers: {} });
  });
});

describe('origin list parsing', () => {
  const fallback = ['http://127.0.0.1:5176'];

  it('keeps only valid origins and never turns invalid input into a wildcard', () => {
    expect(
      parseOrigins(
        'https://app.example.com, not-a-url, javascript:alert(1), https://b.example.com/',
        fallback,
      ),
    ).toEqual(['https://app.example.com']);
  });

  it('falls back to the documented defaults for an empty list', () => {
    expect(parseOrigins(undefined, fallback)).toEqual(fallback);
    expect(parseOrigins('   ', fallback)).toEqual(fallback);
    expect(parseOrigins('nonsense', fallback)).toEqual(fallback);
  });
});
