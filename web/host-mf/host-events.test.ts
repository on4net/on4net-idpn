import { describe, expect, it, vi } from 'vitest';
import type { IdpnEvent } from '@idpn/mfe-sdk';

import { createHostEventLogger, redactEventDetail } from './host-events';

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1MSIsImV4cCI6MX0.c2lnbmF0dXJlLXZhbHVl';

describe('redactEventDetail', () => {
  it('keeps contract fields and drops token-like keys at any depth', () => {
    const event = {
      type: 'auth:login',
      user: { id: 'u1', displayName: 'Negar', email: 'negar@example.com' },
      loginContext: 'default',
      accessToken: JWT,
      refresh_token: JWT,
      nested: { authorization: 'Bearer abc', safe: 'value' },
      clientSecret: 'shh',
      cookie: 'idp_session=1',
    };

    expect(redactEventDetail(event)).toEqual({
      type: 'auth:login',
      user: { id: 'u1', displayName: 'Negar', email: 'negar@example.com' },
      loginContext: 'default',
      nested: { safe: 'value' },
    });
  });

  it('redacts a JWT-shaped string even under an innocuous key', () => {
    expect(redactEventDetail({ type: 'auth:error', code: JWT })).toEqual({
      type: 'auth:error',
      code: '[redacted]',
    });
  });

  it('walks arrays and stops at the depth limit', () => {
    const deep = { a: { b: { c: { d: { e: 'too deep' } } } } };
    const redacted = redactEventDetail(deep) as { a: { b: { c: { d: unknown } } } };

    expect(redacted.a.b.c.d).toBe('[truncated]');
    expect(redactEventDetail({ to: ['/account', { token: JWT }] })).toEqual({
      to: ['/account', {}],
    });
  });

  it('passes through primitives untouched', () => {
    expect(redactEventDetail(null)).toBeNull();
    expect(redactEventDetail(42)).toBe(42);
    expect(redactEventDetail('plain')).toBe('plain');
  });
});

describe('createHostEventLogger', () => {
  it('logs the event type with a redacted payload', () => {
    const sink = vi.fn();
    const logger = createHostEventLogger(sink);

    logger({ type: 'auth:error', code: 'forbidden' });

    expect(sink).toHaveBeenCalledWith('[idpn-host] auth:error', {
      type: 'auth:error',
      code: 'forbidden',
    });
  });

  it('never logs a token smuggled inside an event', () => {
    const sink = vi.fn();
    const logger = createHostEventLogger(sink);
    const tampered = {
      type: 'auth:login',
      user: { id: 'u1', displayName: 'Negar' },
      loginContext: 'default',
      accessToken: JWT,
    } as unknown as IdpnEvent;

    logger(tampered);

    const serialized = JSON.stringify(sink.mock.calls);
    expect(serialized).not.toContain(JWT);
    expect(serialized).not.toContain('accessToken');
    expect(serialized).toContain('auth:login');
  });

  it('falls back to an empty payload when redaction does not yield an object', () => {
    const sink = vi.fn();
    const logger = createHostEventLogger(sink);

    logger(null as unknown as IdpnEvent);

    expect(sink).toHaveBeenCalledWith('[idpn-host] unknown', {});
  });
});
