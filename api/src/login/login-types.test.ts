import { describe, expect, it } from 'vitest';

import { sanitizeReturnTo } from './login-types.js';

const appUrl = 'https://auth.example.com';

describe('sanitizeReturnTo', () => {
  it('keeps same-origin paths', () => {
    expect(sanitizeReturnTo('/account', appUrl)).toBe('/account');
    expect(sanitizeReturnTo('/account?tab=mfa#top', appUrl)).toBe('/account?tab=mfa#top');
    expect(sanitizeReturnTo(`${appUrl}/after`, appUrl)).toBe('https://auth.example.com/after');
  });

  it('rejects foreign, protocol-relative and javascript targets', () => {
    expect(sanitizeReturnTo('https://evil.example.com/x', appUrl)).toBeUndefined();
    expect(sanitizeReturnTo('//evil.example.com/x', appUrl)).toBeUndefined();
    expect(sanitizeReturnTo('javascript:alert(1)', appUrl)).toBeUndefined();
    expect(sanitizeReturnTo(undefined, appUrl)).toBeUndefined();
  });

  it('rejects control characters and backslashes that a browser would normalise', () => {
    // `/<TAB>/evil.example` is read as `//evil.example` by the location parser, and `/\host`
    // likewise: a prefix check alone would let both through (finding 6 of #75).
    expect(sanitizeReturnTo('/\t/evil.example.com', appUrl)).toBeUndefined();
    expect(sanitizeReturnTo('/\n/evil.example.com', appUrl)).toBeUndefined();
    expect(sanitizeReturnTo('/\\evil.example.com', appUrl)).toBeUndefined();
    expect(sanitizeReturnTo('/a\u0000b', appUrl)).toBeUndefined();
  });
});
