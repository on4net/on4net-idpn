import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildSecurityHeaders } from './headers';

/**
 * `headers.ts` is the single source of the policy; `deploy/security/` carries the copies that
 * operators paste into nginx or Caddy. Nothing ties the two together except this test, so a
 * directive added in one place and forgotten in the other fails here instead of shipping a
 * weaker edge (docs/security.md 7).
 */

const CWD = process.cwd();
const REPO_ROOT = basename(CWD) === 'web' ? join(CWD, '..') : CWD;
const read = (name: string): string =>
  readFileSync(join(REPO_ROOT, 'deploy', 'security', name), 'utf8').replace(/\r\n/g, '\n');

const nginx = read('nginx.conf.example');
const caddy = read('Caddyfile.example');

const between = (text: string, start: string, end?: string): string => {
  const from = text.indexOf(start);
  expect(from, `missing "${start}"`).toBeGreaterThanOrEqual(0);
  const to = end === undefined ? text.length : text.indexOf(end, from + start.length);
  return text.slice(from, to === -1 ? text.length : to);
};

/** `add_header Name "value" always;` or `add_header Name 'value' always;` */
function nginxHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const match of block.matchAll(/add_header\s+(\S+)\s+(?:"([^"]*)"|'([^']*)')\s+always;/g)) {
    headers[match[1] ?? ''] = match[2] ?? match[3] ?? '';
  }
  return headers;
}

/** `Name "value"` (or a backtick value) inside a Caddy `header { ... }` block. */
function caddyHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const match of block.matchAll(/^\s*([A-Za-z][A-Za-z-]+)\s+(?:"([^"]*)"|`([^`]*)`)\s*$/gm)) {
    headers[match[1] ?? ''] = match[2] ?? match[3] ?? '';
  }
  return headers;
}

const hosted = buildSecurityHeaders({
  profile: 'hosted',
  dev: false,
  idpOrigins: ['https://auth.example.com'],
  trustedTypesReportOnly: true,
  reportEndpoint: 'https://auth.example.com/csp-report',
});
const remote = buildSecurityHeaders({ profile: 'remote', dev: false });

/** Set by the edge only; `headers.ts` has no business emitting them. */
const EDGE_ONLY = new Set(['Strict-Transport-Security']);

describe.each([
  [
    'nginx',
    nginxHeaders(between(nginx, 'server_name auth.example.com;', 'location / {')),
    nginxHeaders(between(nginx, 'location /idpn-mfe/ {', 'location = /idpn-mfe/manifest.json')),
  ],
  [
    'Caddy',
    caddyHeaders(between(caddy, 'auth.example.com {', 'reverse_proxy')),
    caddyHeaders(between(caddy, '@mfe path /idpn-mfe/*', '@manifest')),
  ],
] as const)('%s example', (_name, hostedExample, remoteExample) => {
  it('carries every header of the Hosted UI profile with the identical value', () => {
    for (const [name, value] of Object.entries(hosted)) {
      expect(hostedExample[name], `${name} is missing or differs`).toBe(value);
    }
  });

  it('adds nothing to the Hosted UI that the policy source does not know', () => {
    const extras = Object.keys(hostedExample).filter(
      (name) => !(name in hosted) && !EDGE_ONLY.has(name),
    );
    expect(extras).toEqual([]);
  });

  it('keeps the remote CSP, CORP and nosniff identical to the remote profile', () => {
    for (const name of [
      'Content-Security-Policy',
      'Cross-Origin-Resource-Policy',
      'X-Content-Type-Options',
      'Referrer-Policy',
    ]) {
      expect(remoteExample[name], `${name} is missing or differs`).toBe(remote[name]);
    }
  });

  it('never answers a remote request with a wildcard origin', () => {
    expect(JSON.stringify(remoteExample)).not.toContain('"*"');
    expect(remoteExample['Access-Control-Allow-Origin']).not.toBe('*');
  });
});

describe('MFE remote CORS behaviour matches decideCors', () => {
  it('nginx admits an empty Origin, refuses a foreign one and answers preflight itself', () => {
    expect(nginx).toMatch(/map \$http_origin \$mfe_origin_ok \{[^}]*""\s+1;/s);
    expect(nginx).toMatch(/if \(\$mfe_origin_ok = 0\) \{\s*return 403;/);
    expect(nginx).toMatch(/if \(\$request_method = OPTIONS\) \{[^}]*return 204;/s);
    expect(nginx).toContain('Access-Control-Allow-Headers "Content-Type, Range"');
    expect(nginx).toContain('Access-Control-Max-Age "600"');
    // No origin variable may be echoed unvalidated.
    expect(nginx).not.toMatch(/Access-Control-Allow-Origin\s+\$http_origin/);
  });

  it('Caddy rejects a foreign Origin and has a real preflight handler', () => {
    expect(caddy).toMatch(/not header Origin https:\/\/app\.example\.com/);
    expect(caddy).toMatch(/respond @foreign_origin "origin not allowed" 403/);
    expect(caddy).toMatch(/method OPTIONS/);
    expect(caddy).toMatch(/respond 204/);
    expect(caddy).toContain('Access-Control-Allow-Headers "Content-Type, Range"');
  });

  it('both examples proxy the CSP report endpoint the policy points at', () => {
    expect(nginx).toMatch(/location = \/csp-report \{[^}]*proxy_pass/s);
    expect(caddy).toMatch(/reverse_proxy \/csp-report /);
  });
});
