import { describe, expect, it } from 'vitest';

import {
  EnvValidationError,
  parsePublicEnv,
  parseServerEnv,
  redactConfig,
  type EnvIssue,
} from './env.js';

const minimalEnv = {
  APP_URL: 'https://auth.example.com',
  DATABASE_URL: 'postgresql://idpn:s3cret@localhost:5432/idpn',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef',
};

const validSocialSecretKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

const captureIssues = (source: Record<string, string | undefined>): EnvIssue[] => {
  try {
    parseServerEnv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    return (error as EnvValidationError).issues;
  }
  throw new Error('expected parseServerEnv to throw');
};

describe('parseServerEnv', () => {
  it('applies defaults for optional values', () => {
    const env = parseServerEnv(minimalEnv);

    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      MFE_ALLOWED_ORIGINS: [],
      WEBAUTHN_ALLOWED_ORIGINS: [],
      TRUSTED_PROXY_CIDRS: [],
      SESSION_MAX_CONCURRENT: 5,
    });
    expect(env.ADMIN_URL).toBeUndefined();
    expect(env.SIGNING_KEY_REF).toBeUndefined();
  });

  it('coerces numeric strings and splits comma separated lists', () => {
    const env = parseServerEnv({
      ...minimalEnv,
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      MFE_ALLOWED_ORIGINS: 'https://app-a.example.com, https://app-b.example.com',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8,192.168.0.0/16',
    });

    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.MFE_ALLOWED_ORIGINS).toEqual([
      'https://app-a.example.com',
      'https://app-b.example.com',
    ]);
    expect(env.TRUSTED_PROXY_CIDRS).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
  });

  it('treats an empty value as missing', () => {
    const issues = captureIssues({ ...minimalEnv, SESSION_SECRET: '' });

    expect(issues).toEqual([{ key: 'SESSION_SECRET', message: 'is required' }]);
  });

  it('defaults the transactional mail sender and rejects a malformed address', () => {
    expect(parseServerEnv(minimalEnv).MAIL_FROM).toBe('no-reply@on4net.dev');
    expect(captureIssues({ ...minimalEnv, MAIL_FROM: 'not-an-email' })[0]?.key).toBe('MAIL_FROM');
  });

  it('reports every missing required key in one error', () => {
    expect(() => parseServerEnv({})).toThrow(EnvValidationError);
    expect(
      captureIssues({})
        .map((issue) => issue.key)
        .sort(),
    ).toEqual(['APP_URL', 'DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET']);
  });

  it('rejects a malformed URL', () => {
    const issues = captureIssues({ ...minimalEnv, APP_URL: 'auth.example.com' });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe('APP_URL');
    expect(issues[0]?.message).toMatch(/url/i);
  });

  it('rejects a secret shorter than 32 characters', () => {
    const issues = captureIssues({ ...minimalEnv, SESSION_SECRET: 'too-short' });

    expect(issues).toEqual([
      { key: 'SESSION_SECRET', message: 'must be at least 32 characters long' },
    ]);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    const issues = captureIssues({ ...minimalEnv, DATABASE_URL: 'mysql://localhost:3306/idpn' });

    expect(issues).toEqual([{ key: 'DATABASE_URL', message: 'must be a postgresql:// URL' }]);
  });

  it('rejects an unknown log level', () => {
    const issues = captureIssues({ ...minimalEnv, LOG_LEVEL: 'verbose' });

    expect(issues[0]?.key).toBe('LOG_LEVEL');
    expect(issues[0]?.message).toMatch(/fatal|error|warn|info|debug|trace|silent/);
  });

  it('parses the metrics switches explicitly and keeps the endpoint off by default', () => {
    const defaults = parseServerEnv(minimalEnv);
    expect(defaults.METRICS_ENABLED).toBe(false);
    expect(defaults.METRICS_TOKEN).toBeUndefined();
    expect(defaults.BACKUP_STATUS_FILE).toBeUndefined();

    const enabled = parseServerEnv({
      ...minimalEnv,
      METRICS_ENABLED: 'true',
      METRICS_TOKEN: '0123456789abcdef',
      BACKUP_STATUS_FILE: 'artifacts/backup/status.json',
    });
    expect(enabled.METRICS_ENABLED).toBe(true);
    expect(enabled.METRICS_TOKEN).toBe('0123456789abcdef');
    expect(enabled.BACKUP_STATUS_FILE).toBe('artifacts/backup/status.json');

    expect(parseServerEnv({ ...minimalEnv, METRICS_ENABLED: 'false' }).METRICS_ENABLED).toBe(false);
    expect(captureIssues({ ...minimalEnv, METRICS_ENABLED: 'yes' })[0]?.key).toBe(
      'METRICS_ENABLED',
    );
    expect(captureIssues({ ...minimalEnv, METRICS_TOKEN: 'too-short' })[0]?.key).toBe(
      'METRICS_TOKEN',
    );
  });

  it('accepts a social secret key of exactly 32 bytes in base64', () => {
    expect(
      parseServerEnv({ ...minimalEnv, SOCIAL_SECRET_KEY: validSocialSecretKey }).SOCIAL_SECRET_KEY,
    ).toBe(validSocialSecretKey);
  });

  it('allows a missing social secret key outside production', () => {
    expect(parseServerEnv(minimalEnv).SOCIAL_SECRET_KEY).toBeUndefined();
    expect(
      parseServerEnv({ ...minimalEnv, SOCIAL_SECRET_KEY: '' }).SOCIAL_SECRET_KEY,
    ).toBeUndefined();
  });

  it('rejects a social secret key that is not 32 bytes of base64', () => {
    const issues = captureIssues({
      ...minimalEnv,
      SOCIAL_SECRET_KEY: 'not-a-32-byte-key',
    });

    expect(issues).toEqual([
      {
        key: 'SOCIAL_SECRET_KEY',
        message: 'must be the base64 encoding of exactly 32 bytes',
      },
    ]);
  });

  it('rejects an allowed origin that carries a path', () => {
    const issues = captureIssues({
      ...minimalEnv,
      MFE_ALLOWED_ORIGINS: 'https://app-a.example.com/login',
    });

    expect(issues[0]?.key).toMatch(/^MFE_ALLOWED_ORIGINS/);
    expect(issues[0]?.message).toMatch(/origin/);
  });

  it('produces a single readable message without leaking values', () => {
    let message = '';
    try {
      parseServerEnv({ ...minimalEnv, SESSION_SECRET: 'leaked-secret-value' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('Invalid environment configuration:');
    expect(message).toContain('SESSION_SECRET');
    expect(message).toContain('docs/setup.md');
    expect(message).not.toContain('leaked-secret-value');
  });
});

describe('parsePublicEnv', () => {
  it('parses the browser visible configuration', () => {
    expect(parsePublicEnv({ VITE_APP_URL: 'https://auth.example.com' })).toEqual({
      VITE_APP_URL: 'https://auth.example.com',
    });
  });

  it('fails when the public URL is missing', () => {
    expect(() => parsePublicEnv({})).toThrow(/VITE_APP_URL: is required/);
  });
});

describe('redactConfig', () => {
  it('masks secrets and stringifies the rest', () => {
    const redacted = redactConfig({
      APP_URL: 'https://auth.example.com',
      SESSION_SECRET: 'super-secret-value',
      SIGNING_KEY_REF: 'vault://idpn/signing',
      MFE_ALLOWED_ORIGINS: ['https://app.example.com'],
      ADMIN_URL: undefined,
    });

    expect(redacted).toEqual({
      APP_URL: 'https://auth.example.com',
      SESSION_SECRET: '***',
      SIGNING_KEY_REF: '***',
      MFE_ALLOWED_ORIGINS: 'https://app.example.com',
      ADMIN_URL: '',
    });
  });
});
