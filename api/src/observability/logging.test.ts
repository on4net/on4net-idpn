import { describe, expect, it } from 'vitest';

import {
  buildLoggerOptions,
  errorLogSerializer,
  REDACT_PATHS,
  redactUrl,
  requestLogSerializer,
  responseLogSerializer,
  sanitizeLogMessage,
  sanitizeRequestId,
} from './logging.js';

describe('sanitizeRequestId', () => {
  it('accepts bounded ids and rejects anything that could inject a log line', () => {
    expect(sanitizeRequestId('req-1234-abcd')).toBe('req-1234-abcd');
    expect(sanitizeRequestId(' 0123456789abcdef0123456789abcdef ')).toBe(
      '0123456789abcdef0123456789abcdef',
    );
    expect(sanitizeRequestId('short')).toBeUndefined();
    expect(sanitizeRequestId('bad id with spaces')).toBeUndefined();
    expect(sanitizeRequestId('bad\nline-12345678')).toBeUndefined();
    expect(sanitizeRequestId('x'.repeat(129))).toBeUndefined();
    expect(sanitizeRequestId(undefined)).toBeUndefined();
    expect(sanitizeRequestId(['array'])).toBeUndefined();
  });
});

describe('redactUrl', () => {
  it('redacts OAuth secrets while keeping routing parameters readable', () => {
    const redacted = redactUrl(
      '/oauth2/authorize?client_id=app-a&access_token=SECRET-A&state=s-1&code=SECRET-B&scope=openid',
    );
    expect(redacted).toContain('client_id=app-a');
    expect(redacted).toContain('state=s-1');
    expect(redacted).toContain('scope=openid');
    expect(redacted).not.toContain('SECRET-A');
    expect(redacted).not.toContain('SECRET-B');
    expect(redacted).toContain('access_token=redacted');
  });

  it('leaves a URL without a query untouched', () => {
    expect(redactUrl('/healthz')).toBe('/healthz');
  });
});

describe('log serializers', () => {
  it('logs only allowlisted request fields and never headers or bodies', () => {
    const serialized = requestLogSerializer({
      id: 'req-1234-abcd',
      method: 'POST',
      url: '/oauth2/token?refresh_token=SECRET-REFRESH',
      ip: '127.0.0.1',
      routeOptions: { url: '/oauth2/token' },
      headers: {
        authorization: 'Bearer SECRET-ACCESS',
        cookie: 'idpn_session=SECRET-COOKIE',
      },
      body: { password: 'SECRET-PASSWORD', client_secret: 'SECRET-CLIENT' },
    });

    expect(serialized).toEqual({
      request_id: 'req-1234-abcd',
      method: 'POST',
      url: '/oauth2/token?refresh_token=redacted',
      route: '/oauth2/token',
      remote_address: '127.0.0.1',
    });
    const json = JSON.stringify(serialized);
    for (const secret of ['SECRET-ACCESS', 'SECRET-COOKIE', 'SECRET-PASSWORD', 'SECRET-CLIENT']) {
      expect(json).not.toContain(secret);
    }
  });

  it('marks unrouted requests as unmatched', () => {
    expect(requestLogSerializer({ method: 'GET', url: '/missing' })).toMatchObject({
      route: 'unmatched',
    });
  });

  it('logs only the response status', () => {
    expect(responseLogSerializer({ statusCode: 503, headers: { 'set-cookie': 'x' } })).toEqual({
      statusCode: 503,
    });
  });

  it('sanitizes error messages and stacks before they reach the log', () => {
    const error = new Error('connect postgresql://idpn:hunter2@db:5432/idpn password=hunter2');
    error.stack = `Error: connect postgresql://idpn:hunter2@db:5432/idpn\n    at db (server.js:1)`;
    const serialized = errorLogSerializer(error);
    const json = JSON.stringify(serialized);
    expect(json).not.toContain('hunter2');
    expect(serialized.type).toBe('Error');
    expect(String(serialized.stack)).toContain('at db (server.js:1)');
  });
});

describe('sanitizeLogMessage', () => {
  it('removes URL credentials, key/value secrets and newlines', () => {
    const message = sanitizeLogMessage(
      new Error('connect redis://idpn:hunter2@cache:6379 failed password=hunter2\nretry token=abc'),
    );
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('token=abc');
    expect(message).not.toContain('\n');
    expect(message).toContain('redis://***@cache:6379');
  });

  it('bounds the length and handles non-Error values', () => {
    expect(sanitizeLogMessage(new Error('x'.repeat(500))).length).toBe(300);
    expect(sanitizeLogMessage('boom')).toBe('boom');
  });
});

describe('buildLoggerOptions', () => {
  it('enables JSON logs with a redact list for credentials', () => {
    const options = buildLoggerOptions('info');
    expect(options.level).toBe('info');
    expect(options.redact.censor).toBe('[redacted]');
    expect(options.redact.paths).toContain('req.headers.authorization');
    expect(options.redact.paths).toContain('req.headers.cookie');
    expect(options.redact.paths).toContain('res.headers["set-cookie"]');
    expect(REDACT_PATHS).toContain('*.refresh_token');
    expect(options.serializers.err).toBe(errorLogSerializer);
    expect(options.base).toMatchObject({ service: 'on4net-idpn-api' });
    expect(options.timestamp()).toMatch(/^,"time":"\d{4}-\d{2}-\d{2}T/);
  });
});
