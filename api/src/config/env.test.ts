import { describe, expect, it } from 'vitest';

import { loadApiEnv } from './env.js';

const validEnv = {
  APP_URL: 'https://auth.example.com',
  DATABASE_URL: 'postgresql://idpn:s3cret@localhost:5432/idpn',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef',
};

describe('loadApiEnv', () => {
  it('returns a validated environment', () => {
    const env = loadApiEnv(validEnv);

    expect(env.APP_URL).toBe('https://auth.example.com');
    expect(env.PORT).toBe(6000);
  });

  it('throws a readable error naming every invalid key', () => {
    expect(() =>
      loadApiEnv({ ...validEnv, APP_URL: 'not-a-url', SESSION_SECRET: 'short' }),
    ).toThrow(/APP_URL[\s\S]*SESSION_SECRET/);
  });
});
