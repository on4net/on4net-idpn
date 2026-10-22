import { describe, expect, it, vi } from 'vitest';

import { createSecurityAlertSink, type SecurityAlert } from './alerts.js';

const alert: SecurityAlert = {
  type: 'mfa.lockout',
  severity: 'high',
  userId: 'user-1',
  ip: '203.0.113.7',
};

describe('security alert sink', () => {
  it('delivers the alert to the metric and the log', () => {
    const log = vi.fn();
    const metric = vi.fn();
    createSecurityAlertSink({ log, metric }).raise(alert);

    expect(metric).toHaveBeenCalledWith(alert);
    expect(log).toHaveBeenCalledWith(alert);
  });

  it('still logs when the metric sink throws, and never throws itself', () => {
    const log = vi.fn();
    const sink = createSecurityAlertSink({
      log,
      metric: () => {
        throw new Error('metrics down');
      },
    });

    expect(() => sink.raise(alert)).not.toThrow();
    expect(log).toHaveBeenCalledWith(alert);
  });

  it('swallows a failing log sink so authentication keeps working', () => {
    const sink = createSecurityAlertSink({
      log: () => {
        throw new Error('logger down');
      },
    });
    expect(() => sink.raise(alert)).not.toThrow();
  });
});
