import { describe, expect, it } from 'vitest';

import { ApiMetrics, Counter, Gauge, Histogram, MetricsRegistry } from './metrics.js';

const dropNothing = (): void => undefined;

describe('Counter and Gauge', () => {
  it('renders the Prometheus text format with sorted, escaped labels', () => {
    const counter = new Counter('idpn_test_total', 'A test counter.', dropNothing);
    counter.inc({ route: '/oauth2/token', method: 'POST' });
    counter.inc({ method: 'POST', route: '/oauth2/token' }, 2);
    counter.inc({ label: 'a "quoted" \\ value\nline' });

    const rendered = counter.render();
    expect(rendered).toContain('# HELP idpn_test_total A test counter.');
    expect(rendered).toContain('# TYPE idpn_test_total counter');
    expect(rendered).toContain('idpn_test_total{method="POST",route="/oauth2/token"} 3');
    expect(rendered).toContain('label="a \\"quoted\\" \\\\ value\\nline"');
  });

  it('rejects decreases and invalid labels', () => {
    const counter = new Counter('idpn_test_total', 'A test counter.', dropNothing);
    expect(() => counter.inc({}, -1)).toThrow(/increase/);
    expect(() => counter.inc({ 'bad-label': 'x' })).toThrow(/invalid metric label name/);
  });

  it('sets gauge values and rejects non-finite numbers', () => {
    const gauge = new Gauge('idpn_test_gauge', 'A test gauge.', dropNothing);
    gauge.set({ service: 'postgres' }, 1);
    gauge.set({ service: 'postgres' }, 0);
    expect(gauge.render()).toContain('idpn_test_gauge{service="postgres"} 0');
    expect(() => gauge.set({}, Number.NaN)).toThrow(/finite/);
  });
});

describe('Histogram', () => {
  it('renders cumulative buckets, sum and count', () => {
    const histogram = new Histogram(
      'idpn_test_seconds',
      'A test histogram.',
      [0.1, 0.5],
      dropNothing,
    );
    histogram.observe({ route: '/healthz' }, 0.05);
    histogram.observe({ route: '/healthz' }, 0.4);
    histogram.observe({ route: '/healthz' }, 2);

    const rendered = histogram.render();
    expect(rendered).toContain('idpn_test_seconds_bucket{route="/healthz",le="0.1"} 1');
    expect(rendered).toContain('idpn_test_seconds_bucket{route="/healthz",le="0.5"} 2');
    expect(rendered).toContain('idpn_test_seconds_bucket{route="/healthz",le="+Inf"} 3');
    expect(rendered).toContain('idpn_test_seconds_sum{route="/healthz"} 2.45');
    expect(rendered).toContain('idpn_test_seconds_count{route="/healthz"} 3');
  });

  it('requires ascending buckets', () => {
    expect(() => new Histogram('idpn_test_seconds', 'x', [1, 1], dropNothing)).toThrow(/ascending/);
    expect(() => new Histogram('idpn_test_seconds', 'x', [], dropNothing)).toThrow(/bucket/);
  });
});

describe('MetricsRegistry', () => {
  it('refuses duplicate metric names', () => {
    const registry = new MetricsRegistry();
    registry.counter('idpn_duplicate_total', 'first');
    expect(() => registry.gauge('idpn_duplicate_total', 'second')).toThrow(/already registered/);
  });

  it('caps label cardinality and counts dropped series', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('idpn_bounded_total', 'bounded');
    for (let index = 0; index < 1_005; index += 1) {
      counter.inc({ route: `/route-${index}` });
    }
    const rendered = registry.render();
    expect(rendered).toContain('idpn_bounded_total{route="/route-999"} 1');
    expect(rendered).not.toContain('route="/route-1000"');
    expect(rendered).toContain('idpn_metrics_series_dropped_total 5');
  });
});

describe('ApiMetrics', () => {
  it('labels HTTP metrics with the matched route, never the raw URL', () => {
    const metrics = new ApiMetrics();
    metrics.recordHttpRequest({
      method: 'post',
      route: '/oauth2/token',
      status: 200,
      durationSeconds: 0.12,
    });
    metrics.recordHttpRequest({
      method: 'GET',
      route: 'unmatched',
      status: 404,
      durationSeconds: 0.01,
    });

    const rendered = metrics.render();
    expect(rendered).toContain(
      'idpn_http_requests_total{method="POST",route="/oauth2/token",status="200"} 1',
    );
    expect(rendered).toContain(
      'idpn_http_requests_total{method="GET",route="unmatched",status="404"} 1',
    );
    expect(rendered).toContain(
      'idpn_http_request_duration_seconds_count{method="POST",route="/oauth2/token",status="200"} 1',
    );
  });

  it('records token, auth, revocation and back-channel outcomes', () => {
    const metrics = new ApiMetrics();
    metrics.recordAuthFailure('/oauth2/token', 'invalid_client');
    metrics.recordTokenRequest({ grantType: 'refresh_token', success: true });
    metrics.recordTokenRequest({ grantType: 'refresh_token', success: false });
    metrics.recordTokenRequest({ grantType: 'made-up grant', success: false });
    metrics.recordRefreshReuse();
    metrics.recordTokenRevocation();
    metrics.recordBackchannelDelivery('queued');
    metrics.recordCollectorError('backup_status');

    const rendered = metrics.render();
    expect(rendered).toContain(
      'idpn_auth_failures_total{reason="invalid_client",route="/oauth2/token"} 1',
    );
    expect(rendered).toContain(
      'idpn_token_requests_total{grant_type="refresh_token",result="success"} 1',
    );
    expect(rendered).toContain(
      'idpn_token_requests_total{grant_type="refresh_token",result="error"} 1',
    );
    expect(rendered).toContain('idpn_token_requests_total{grant_type="unknown",result="error"} 1');
    expect(rendered).toContain('idpn_tokens_issued_total{grant_type="refresh_token"} 1');
    expect(rendered).toContain('idpn_token_refresh_total{result="error"} 1');
    expect(rendered).toContain('idpn_refresh_token_reuse_detected_total 1');
    expect(rendered).toContain('idpn_token_revocations_total 1');
    expect(rendered).toContain('idpn_backchannel_logout_total{status="queued"} 1');
    expect(rendered).toContain('idpn_metrics_collector_errors_total{collector="backup_status"} 1');
  });

  it('renders gauges for dependencies, sessions, keys, queue and backups', () => {
    const metrics = new ApiMetrics();
    metrics.dependencyUp.set({ service: 'postgres' }, 1);
    metrics.activeSessions.set({}, 42);
    metrics.signingKeyAgeDays.set({}, 12);
    metrics.signingKeyRotationDue.set({}, 0);
    metrics.backchannelQueueDepth.set({}, 3);
    metrics.backupLastSuccess.set({}, 1_760_000_000);

    const rendered = metrics.render();
    expect(rendered).toContain('idpn_dependency_up{service="postgres"} 1');
    expect(rendered).toContain('idpn_active_sessions 42');
    expect(rendered).toContain('idpn_signing_key_age_days 12');
    expect(rendered).toContain('idpn_signing_key_rotation_due 0');
    expect(rendered).toContain('idpn_backchannel_queue_depth 3');
    expect(rendered).toContain('idpn_backup_last_success_timestamp_seconds 1760000000');
  });
});
