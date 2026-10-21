import { describe, expect, it } from 'vitest';

import { parseBasicAuthHeader } from './client-auth.js';

const basic = (value: string): string => `Basic ${Buffer.from(value, 'utf8').toString('base64')}`;

describe('parseBasicAuthHeader', () => {
  it('decodes percent-encoded credentials (RFC 6749 2.3.1)', () => {
    expect(parseBasicAuthHeader(basic('app%2Da:s%3Acret'))).toEqual({
      clientId: 'app-a',
      clientSecret: 's:cret',
    });
  });

  it('treats a malformed percent escape as bad credentials instead of throwing', () => {
    // `%` alone is not a valid escape; URL-decoding used to throw and surface as a 500.
    expect(parseBasicAuthHeader(basic('app-a:se%zzcret'))).toBeNull();
    expect(parseBasicAuthHeader(basic('app%:secret'))).toBeNull();
  });

  it('rejects headers without a colon or with the wrong scheme', () => {
    expect(parseBasicAuthHeader(basic('app-a'))).toBeNull();
    expect(parseBasicAuthHeader('Bearer token')).toBeNull();
    expect(parseBasicAuthHeader(undefined)).toBeNull();
  });
});
