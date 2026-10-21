import { describe, expect, it } from 'vitest';

import { DEFAULT_REMOTE_ENTRY, isSafeTarget, resolveRemoteEntry } from './targets';

describe('isSafeTarget', () => {
  it('accepts same-origin paths and absolute http(s) URLs', () => {
    expect(isSafeTarget('/auth')).toBe(true);
    expect(isSafeTarget('/')).toBe(true);
    expect(isSafeTarget('https://auth.example.com/api')).toBe(true);
    expect(isSafeTarget('http://127.0.0.1:3000/api')).toBe(true);
  });

  it('rejects protocol-relative targets, including the backslash forms', () => {
    for (const target of [
      '//evil.example.com/x',
      '/\\evil.example.com/x',
      '\\\\evil.example.com/x',
      '\\evil.example.com',
    ]) {
      expect(isSafeTarget(target), target).toBe(false);
    }
  });

  it('rejects non-http schemes, bare segments and whitespace', () => {
    for (const target of ['javascript:alert(1)', 'data:text/html,x', 'auth', '', ' /auth', '/a b']) {
      expect(isSafeTarget(target), target).toBe(false);
    }
  });
});

describe('resolveRemoteEntry', () => {
  it('defaults to the same-origin copy and adds no CSP origin', () => {
    expect(resolveRemoteEntry(undefined)).toEqual({ entry: DEFAULT_REMOTE_ENTRY, origins: [] });
    expect(resolveRemoteEntry('  ')).toEqual({ entry: DEFAULT_REMOTE_ENTRY, origins: [] });
    expect(resolveRemoteEntry('/remote/remoteEntry.js')).toEqual({
      entry: '/remote/remoteEntry.js',
      origins: [],
    });
  });

  it('accepts an allowlisted https CDN origin and returns exactly that origin', () => {
    expect(
      resolveRemoteEntry('https://cdn.example.com/idpn-mfe/1.4.0/remoteEntry.js', [
        'https://cdn.example.com',
      ]),
    ).toEqual({
      entry: 'https://cdn.example.com/idpn-mfe/1.4.0/remoteEntry.js',
      origins: ['https://cdn.example.com'],
    });
  });

  it('rejects an absolute entry whose origin is not allowlisted', () => {
    expect(() =>
      resolveRemoteEntry('https://evil.example.com/remoteEntry.js', ['https://cdn.example.com']),
    ).toThrow(/not in IDPN_REMOTE_ORIGINS/);
  });

  it('rejects plain http, protocol-relative and backslash entries', () => {
    expect(() => resolveRemoteEntry('http://cdn.example.com/remoteEntry.js')).toThrow(/https/);
    expect(() => resolveRemoteEntry('//cdn.example.com/remoteEntry.js')).toThrow();
    expect(() => resolveRemoteEntry('/\\cdn.example.com/remoteEntry.js')).toThrow();
  });
});
