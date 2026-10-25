import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { parseCspReports, registerCspReportRoute } from './csp-report.js';
import { ApiMetrics } from './metrics.js';

const legacy = {
  'csp-report': {
    'document-uri': 'https://auth.example.com/login?token=SECRET#frag',
    'violated-directive': 'script-src-elem',
    'effective-directive': 'script-src-elem',
    'blocked-uri': 'https://evil.example/x.js?k=SECRET',
    disposition: 'enforce',
    'script-sample': 'alert(1)',
  },
};

const reportingApi = [
  {
    type: 'csp-violation',
    body: {
      documentURL: 'https://auth.example.com/',
      effectiveDirective: 'require-trusted-types-for',
      blockedURL: 'trusted-types-sink',
      disposition: 'report',
      sample: 'innerHTML',
    },
  },
];

describe('parseCspReports', () => {
  it('reads the legacy format and keeps only origin and path of every URL', () => {
    const [violation] = parseCspReports(legacy);
    expect(violation).toMatchObject({
      directive: 'script-src-elem',
      document: 'https://auth.example.com/login',
      blocked: 'https://evil.example/x.js',
    });
    expect(JSON.stringify(violation)).not.toContain('SECRET');
  });

  it('reads the Reporting API format', () => {
    expect(parseCspReports(reportingApi)).toEqual([
      expect.objectContaining({
        directive: 'require-trusted-types-for',
        disposition: 'report',
        sample: 'innerHTML',
      }),
    ]);
  });

  it('ignores junk and bounds the batch', () => {
    expect(parseCspReports('x')).toEqual([]);
    expect(parseCspReports(null)).toEqual([]);
    expect(parseCspReports([{ type: 'x', body: 5 }])).toEqual([]);
    expect(parseCspReports(Array.from({ length: 50 }, () => reportingApi[0]))).toHaveLength(10);
  });
});

async function build(options: Parameters<typeof registerCspReportRoute>[1] = {}) {
  const app = Fastify({ logger: false });
  registerCspReportRoute(app, options);
  await app.ready();
  return app;
}

describe('POST /csp-report', () => {
  it('answers 204 for both content types, counts the violation and logs without secrets', async () => {
    const metrics = new ApiMetrics();
    const logged: unknown[] = [];
    const app = await build({
      metrics,
      logger: { warn: (entry) => logged.push(entry) },
    });

    const first = await app.inject({
      method: 'POST',
      url: '/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: JSON.stringify(legacy),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/csp-report',
      headers: { 'content-type': 'application/reports+json' },
      payload: JSON.stringify(reportingApi),
    });

    expect([first.statusCode, second.statusCode]).toEqual([204, 204]);
    expect(first.body).toBe('');
    expect(logged).toHaveLength(2);
    expect(JSON.stringify(logged)).not.toContain('SECRET');
    const text = metrics.registry.render();
    expect(text).toContain(
      'idpn_csp_reports_total{directive="script-src-elem",disposition="enforce"} 1',
    );
    expect(text).toContain('directive="require-trusted-types-for",disposition="report"');
    await app.close();
  });

  it('accepts malformed JSON and oversized bodies without a server error', async () => {
    const app = await build();
    const malformed = await app.inject({
      method: 'POST',
      url: '/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(204);
    const huge = await app.inject({
      method: 'POST',
      url: '/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: 'x'.repeat(64 * 1024),
    });
    expect(huge.statusCode).toBe(413);
    await app.close();
  });

  it('stops recording after the per-address budget but keeps answering 204', async () => {
    const metrics = new ApiMetrics();
    const app = await build({ metrics, perMinute: 2, now: () => 1_000 });
    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/csp-report',
        headers: { 'content-type': 'application/csp-report' },
        payload: JSON.stringify(legacy),
      });
      expect(response.statusCode).toBe(204);
    }
    expect(metrics.registry.render()).toContain(
      'idpn_csp_reports_total{directive="script-src-elem",disposition="enforce"} 2',
    );
    await app.close();
  });
});
