import type { BackchannelDeliveryStatus } from '../oidc/backchannel-logout.js';

/**
 * Minimal Prometheus text-format registry (docs/monitoring.md).
 *
 * The API intentionally does not depend on a metrics client: the exposition format is
 * small and stable, and keeping the registry local makes the endpoint testable without a
 * background collector. Every metric is bounded: at most {@link MAX_SERIES_PER_METRIC}
 * label sets are kept per metric so a caller cannot grow memory through route or query
 * values. Dropped series are counted in `idpn_metrics_series_dropped_total`.
 */
export type MetricLabels = Record<string, string | number | boolean>;

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_SERIES_PER_METRIC = 1_000;

type NormalizedLabel = readonly [name: string, value: string];

interface Series {
  readonly labels: readonly NormalizedLabel[];
  value: number;
}

interface HistogramSeries {
  readonly labels: readonly NormalizedLabel[];
  readonly bucketCounts: number[];
  sum: number;
  count: number;
}

function normalizeLabels(labels: MetricLabels): readonly NormalizedLabel[] {
  return Object.entries(labels)
    .map(([name, value]) => {
      if (!LABEL_NAME.test(name)) {
        throw new Error(`invalid metric label name: ${name}`);
      }
      return [name, String(value)] as const;
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function seriesKey(labels: readonly NormalizedLabel[]): string {
  return labels.map(([name, value]) => `${name}\u0000${value}`).join('\u0001');
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatLabels(labels: readonly NormalizedLabel[]): string {
  if (labels.length === 0) {
    return '';
  }
  return `{${labels.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(',')}}`;
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error('metric values must be finite');
  }
  if (Object.is(value, -0)) {
    return '0';
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return String(Number(value.toFixed(9)));
}

abstract class Metric {
  protected readonly series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: 'counter' | 'gauge',
    private readonly onDrop: () => void,
  ) {
    if (!METRIC_NAME.test(name)) {
      throw new Error(`invalid metric name: ${name}`);
    }
  }

  protected seriesFor(labels: MetricLabels): Series | null {
    const normalized = normalizeLabels(labels);
    const key = seriesKey(normalized);
    const existing = this.series.get(key);
    if (existing !== undefined) {
      return existing;
    }
    if (this.series.size >= MAX_SERIES_PER_METRIC) {
      this.onDrop();
      return null;
    }
    const created: Series = { labels: normalized, value: 0 };
    this.series.set(key, created);
    return created;
  }

  protected sortedSeries(): Series[] {
    return [...this.series.values()].sort((left, right) =>
      seriesKey(left.labels).localeCompare(seriesKey(right.labels)),
    );
  }

  render(): string {
    const lines = [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} ${this.type}`,
    ];
    for (const series of this.sortedSeries()) {
      lines.push(`${this.name}${formatLabels(series.labels)} ${formatValue(series.value)}`);
    }
    return lines.join('\n');
  }
}

export class Counter extends Metric {
  constructor(name: string, help: string, onDrop: () => void) {
    super(name, help, 'counter', onDrop);
  }

  inc(labels: MetricLabels = {}, value = 1): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('counters can only increase');
    }
    const series = this.seriesFor(labels);
    if (series !== null) {
      series.value += value;
    }
  }
}

export class Gauge extends Metric {
  constructor(name: string, help: string, onDrop: () => void) {
    super(name, help, 'gauge', onDrop);
  }

  set(labels: MetricLabels, value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error('gauge values must be finite');
    }
    const series = this.seriesFor(labels);
    if (series !== null) {
      series.value = value;
    }
  }
}

/** Cumulative histogram without exemplars; buckets must be ascending and finite. */
export class Histogram {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[],
    private readonly onDrop: () => void,
  ) {
    if (!METRIC_NAME.test(name)) {
      throw new Error(`invalid metric name: ${name}`);
    }
    if (buckets.length === 0) {
      throw new Error('a histogram needs at least one bucket');
    }
    for (let index = 1; index < buckets.length; index += 1) {
      const previous = buckets[index - 1];
      const current = buckets[index];
      if (previous === undefined || current === undefined || !(current > previous)) {
        throw new Error('histogram buckets must be ascending');
      }
    }
  }

  observe(labels: MetricLabels, value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('histogram observations must be finite and non-negative');
    }
    const normalized = normalizeLabels(labels);
    const key = seriesKey(normalized);
    let series = this.series.get(key);
    if (series === undefined) {
      if (this.series.size >= MAX_SERIES_PER_METRIC) {
        this.onDrop();
        return;
      }
      series = {
        labels: normalized,
        bucketCounts: this.buckets.map(() => 0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, series);
    }

    const bucketIndex = this.buckets.findIndex((bucket) => value <= bucket);
    if (bucketIndex >= 0) {
      series.bucketCounts[bucketIndex] = (series.bucketCounts[bucketIndex] ?? 0) + 1;
    }
    series.sum += value;
    series.count += 1;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} histogram`];
    const sorted = [...this.series.values()].sort((left, right) =>
      seriesKey(left.labels).localeCompare(seriesKey(right.labels)),
    );
    for (const series of sorted) {
      let cumulative = 0;
      for (const [index, bucket] of this.buckets.entries()) {
        cumulative += series.bucketCounts[index] ?? 0;
        lines.push(
          `${this.name}_bucket${formatLabels([
            ...series.labels,
            ['le', formatValue(bucket)],
          ])} ${formatValue(cumulative)}`,
        );
      }
      lines.push(
        `${this.name}_bucket${formatLabels([...series.labels, ['le', '+Inf']])} ${formatValue(
          series.count,
        )}`,
      );
      lines.push(`${this.name}_sum${formatLabels(series.labels)} ${formatValue(series.sum)}`);
      lines.push(`${this.name}_count${formatLabels(series.labels)} ${formatValue(series.count)}`);
    }
    return lines.join('\n');
  }
}

export class MetricsRegistry {
  private readonly metrics: { readonly name: string; render(): string }[] = [];
  private readonly names = new Set<string>();
  private droppedSeries = 0;

  private readonly noteDrop = (): void => {
    this.droppedSeries += 1;
  };

  private assertUnique(name: string): void {
    if (this.names.has(name)) {
      throw new Error(`metric already registered: ${name}`);
    }
    this.names.add(name);
  }

  counter(name: string, help: string): Counter {
    this.assertUnique(name);
    const metric = new Counter(name, help, this.noteDrop);
    this.metrics.push(metric);
    return metric;
  }

  gauge(name: string, help: string): Gauge {
    this.assertUnique(name);
    const metric = new Gauge(name, help, this.noteDrop);
    this.metrics.push(metric);
    return metric;
  }

  histogram(name: string, help: string, buckets: readonly number[]): Histogram {
    this.assertUnique(name);
    const metric = new Histogram(name, help, buckets, this.noteDrop);
    this.metrics.push(metric);
    return metric;
  }

  render(): string {
    const blocks = this.metrics
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((metric) => metric.render());
    blocks.push(
      [
        '# HELP idpn_metrics_series_dropped_total Label sets dropped after the per-metric cap.',
        '# TYPE idpn_metrics_series_dropped_total counter',
        `idpn_metrics_series_dropped_total ${formatValue(this.droppedSeries)}`,
      ].join('\n'),
    );
    return `${blocks.join('\n')}\n`;
  }
}

/** Latency buckets aligned with the SLOs in docs/architecture.md 6 (token p95 < 300 ms). */
export const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.3, 0.5, 0.75, 1, 2.5, 5, 10,
] as const;

export interface HttpRequestObservation {
  method: string;
  /** Matched route pattern (never the raw URL) or `unmatched` for a 404. */
  route: string;
  status: number;
  durationSeconds: number;
}

export interface TokenRequestObservation {
  grantType: string;
  success: boolean;
}

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return ALLOWED_METHODS.has(upper) ? upper : 'OTHER';
}

function normalizeRoute(route: string): string {
  return route.startsWith('/') ? route : 'unmatched';
}

function normalizeGrantType(grantType: string): string {
  return /^[a-z_]{1,64}$/.test(grantType) ? grantType : 'unknown';
}

/** All IDPN metrics and their recording helpers (docs/monitoring.md). */
export class ApiMetrics {
  readonly registry = new MetricsRegistry();

  readonly httpRequests = this.registry.counter(
    'idpn_http_requests_total',
    'HTTP requests handled by the API, by method, matched route and status.',
  );

  readonly httpDuration = this.registry.histogram(
    'idpn_http_request_duration_seconds',
    'HTTP request duration in seconds, by method, matched route and status.',
    HTTP_DURATION_BUCKETS,
  );

  readonly authFailures = this.registry.counter(
    'idpn_auth_failures_total',
    'Rejected authentication or authorization attempts, by route and reason.',
  );

  readonly tokenRequests = this.registry.counter(
    'idpn_token_requests_total',
    'Token endpoint requests, by grant type and result.',
  );

  readonly tokensIssued = this.registry.counter(
    'idpn_tokens_issued_total',
    'Successful token endpoint responses, by grant type.',
  );

  readonly tokenRefresh = this.registry.counter(
    'idpn_token_refresh_total',
    'Refresh-token grant results.',
  );

  readonly refreshReuse = this.registry.counter(
    'idpn_refresh_token_reuse_detected_total',
    'Refresh tokens presented after rotation; the whole family is revoked.',
  );

  readonly tokenRevocations = this.registry.counter(
    'idpn_token_revocations_total',
    'Accepted revocation requests.',
  );

  readonly backchannel = this.registry.counter(
    'idpn_backchannel_logout_total',
    'Back-channel logout delivery results, by status.',
  );

  readonly collectorErrors = this.registry.counter(
    'idpn_metrics_collector_errors_total',
    'Gauge collectors that failed during a scrape, by collector.',
  );

  readonly activeSessions = this.registry.gauge(
    'idpn_active_sessions',
    'Non-revoked, non-expired IdP sessions recorded in PostgreSQL.',
  );

  readonly dependencyUp = this.registry.gauge(
    'idpn_dependency_up',
    'Readiness probe result for a dependency (1 = up, 0 = down).',
  );

  readonly signingKeyAgeDays = this.registry.gauge(
    'idpn_signing_key_age_days',
    'Age of the active signing key in days.',
  );

  readonly signingKeyRotationDue = this.registry.gauge(
    'idpn_signing_key_rotation_due',
    '1 when the active signing key passed the rotation threshold.',
  );

  readonly backchannelQueueDepth = this.registry.gauge(
    'idpn_backchannel_queue_depth',
    'Durable back-channel logout queue entries waiting for the retry worker.',
  );

  readonly backupLastSuccess = this.registry.gauge(
    'idpn_backup_last_success_timestamp_seconds',
    'Unix timestamp of the last successful PostgreSQL/Redis backup.',
  );

  recordHttpRequest(observation: HttpRequestObservation): void {
    if (!Number.isFinite(observation.status) || observation.status < 100) {
      return;
    }
    const labels = {
      method: normalizeMethod(observation.method),
      route: normalizeRoute(observation.route),
      status: String(observation.status),
    };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(
      { method: labels.method, route: labels.route, status: labels.status },
      observation.durationSeconds,
    );
  }

  recordAuthFailure(route: string, reason: string): void {
    this.authFailures.inc({ route: normalizeRoute(route), reason });
  }

  recordTokenRequest(observation: TokenRequestObservation): void {
    const grantType = normalizeGrantType(observation.grantType);
    this.tokenRequests.inc({
      grant_type: grantType,
      result: observation.success ? 'success' : 'error',
    });
    if (observation.success) {
      this.tokensIssued.inc({ grant_type: grantType });
    }
    if (grantType === 'refresh_token') {
      this.tokenRefresh.inc({ result: observation.success ? 'success' : 'error' });
    }
  }

  recordRefreshReuse(): void {
    this.refreshReuse.inc();
  }

  recordTokenRevocation(): void {
    this.tokenRevocations.inc();
  }

  recordBackchannelDelivery(status: BackchannelDeliveryStatus): void {
    this.backchannel.inc({ status });
  }

  recordCollectorError(collector: string): void {
    this.collectorErrors.inc({ collector });
  }

  render(): string {
    return this.registry.render();
  }
}
