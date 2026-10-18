import { describe, expect, it } from 'vitest';

import { loadWebEnv } from './env.js';

describe('loadWebEnv', () => {
  it('returns the validated public configuration', () => {
    expect(loadWebEnv({ VITE_APP_URL: 'https://auth.example.com' })).toEqual({
      VITE_APP_URL: 'https://auth.example.com',
    });
  });

  it('fails fast when the public IdP URL is missing', () => {
    expect(() => loadWebEnv({})).toThrow(/VITE_APP_URL: is required/);
  });
});
