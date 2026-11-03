import { describe, expect, it, vi } from 'vitest';

import { DependencyMonitor, sanitizeDependencyError } from './health.js';

describe('DependencyMonitor', () => {
  it('reports ok when every probe resolves', async () => {
    const monitor = new DependencyMonitor({
      probes: [
        { name: 'postgres', check: async () => undefined },
        { name: 'redis', check: async () => 'PONG' },
      ],
      timeoutMs: 100,
    });

    const report = await monitor.check({ fresh: true });
    expect(report).toMatchObject({
      status: 'ok',
      service: 'on4net-idpn-api',
      checks: [
        { name: 'postgres', status: 'ok' },
        { name: 'redis', status: 'ok' },
      ],
    });
    expect(report.checks.every((check) => check.durationMs >= 0)).toBe(true);
    expect(() => new Date(report.timestamp).toISOString()).not.toThrow();
  });

  it('reports degraded when one dependency rejects and sanitizes the error', async () => {
    const monitor = new DependencyMonitor({
      probes: [
        { name: 'postgres', check: async () => undefined },
        {
          name: 'redis',
          check: async () => {
            throw new Error(
              'connect ECONNREFUSED redis://idpn:s3cr3t@127.0.0.1:6379 password=hunter2',
            );
          },
        },
      ],
      timeoutMs: 100,
    });

    const report = await monitor.check({ fresh: true });
    expect(report.status).toBe('degraded');
    expect(report.checks[1]).toMatchObject({ name: 'redis', status: 'down' });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('s3cr3t');
    expect(serialized).not.toContain('hunter2');
    expect(report.checks[1]?.error).toContain('ECONNREFUSED');
  });

  it('marks a hung dependency down after the timeout', async () => {
    const monitor = new DependencyMonitor({
      probes: [
        {
          name: 'postgres',
          check: () => new Promise(() => undefined),
        },
      ],
      timeoutMs: 20,
    });

    const startedAt = Date.now();
    const report = await monitor.check({ fresh: true });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(report.status).toBe('degraded');
    expect(report.checks[0]?.error).toContain('timed out');
  });

  it('reuses a cached report for scrapes but not for readiness', async () => {
    const postgres = vi.fn(async () => undefined);
    const monitor = new DependencyMonitor({
      probes: [{ name: 'postgres', check: postgres }],
      timeoutMs: 100,
      cacheTtlMs: 60_000,
    });

    await monitor.check();
    await monitor.check();
    expect(postgres).toHaveBeenCalledTimes(1);

    await monitor.check({ fresh: true });
    expect(postgres).toHaveBeenCalledTimes(2);
  });

  it('requires at least one probe', () => {
    expect(() => new DependencyMonitor({ probes: [] })).toThrow(/at least one/);
  });
});

describe('sanitizeDependencyError', () => {
  it('collapses lines and truncates to 200 characters', () => {
    const message = sanitizeDependencyError(new Error(`failed\nnext\t${'x'.repeat(400)}`));
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThanOrEqual(200);
  });

  it('handles non-Error values', () => {
    expect(sanitizeDependencyError('boom')).toBe('boom');
    expect(sanitizeDependencyError(undefined)).toBe('undefined');
  });
});
