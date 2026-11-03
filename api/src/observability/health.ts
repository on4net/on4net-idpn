import { performance } from 'node:perf_hooks';

/**
 * Dependency readiness (docs/monitoring.md).
 *
 * `/healthz` stays a process-liveness probe and never touches PostgreSQL or Redis.
 * `/readyz` runs every registered dependency probe with a hard timeout and answers `503`
 * when one is down, so a load balancer stops routing to an instance that cannot serve.
 */
export const READINESS_SERVICE = 'on4net-idpn-api';

export type DependencyStatus = 'ok' | 'down';

export interface DependencyProbe {
  name: string;
  /** Resolves when the dependency answers; a rejection or timeout marks it down. */
  check: () => Promise<unknown>;
}

export interface DependencyCheckResult {
  name: string;
  status: DependencyStatus;
  durationMs: number;
  error?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  service: typeof READINESS_SERVICE;
  timestamp: string;
  checks: DependencyCheckResult[];
}

export interface DependencyMonitorOptions {
  probes: readonly DependencyProbe[];
  /** Per-probe timeout; a hung dependency must not hold the probe open. */
  timeoutMs?: number;
  /** Reuse a recent result for scrape collection; `/readyz` always requests a fresh one. */
  cacheTtlMs?: number;
  now?: () => Date;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
export const DEFAULT_READINESS_CACHE_TTL_MS = 10_000;

export class DependencyTimeoutError extends Error {
  override readonly name = 'DependencyTimeoutError';
}

/**
 * Removes URI credentials or key/value secrets an underlying client may include in an
 * error, and collapses the message to one bounded line. The report is served to the load
 * balancer and is not an authorization boundary, so it must not carry secrets.
 */
export function sanitizeDependencyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const singleLine = raw.replace(/[\r\n\t]+/g, ' ').trim();
  const withoutUserInfo = singleLine.replace(/\/\/[^/@\s]+@/g, '//***@');
  const withoutPairs = withoutUserInfo.replace(
    /\b(password|passwd|secret|token|pwd)\s*=\s*[^\s&;]+/gi,
    '$1=***',
  );
  return withoutPairs.slice(0, 200) || 'dependency check failed';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DependencyTimeoutError(`probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class DependencyMonitor {
  private readonly probes: readonly DependencyProbe[];
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;
  private cached: { checkedAtMs: number; report: ReadinessReport } | null = null;

  constructor(options: DependencyMonitorOptions) {
    if (options.probes.length === 0) {
      throw new Error('a readiness monitor needs at least one dependency probe');
    }
    this.probes = options.probes;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  async check(options: { fresh?: boolean } = {}): Promise<ReadinessReport> {
    const checkedAtMs = this.now().getTime();
    if (
      options.fresh !== true &&
      this.cached !== null &&
      checkedAtMs - this.cached.checkedAtMs < this.cacheTtlMs
    ) {
      return this.cached.report;
    }

    const checks = await Promise.all(this.probes.map((probe) => this.runProbe(probe)));
    const report: ReadinessReport = {
      status: checks.every((check) => check.status === 'ok') ? 'ok' : 'degraded',
      service: READINESS_SERVICE,
      timestamp: new Date(checkedAtMs).toISOString(),
      checks,
    };
    this.cached = { checkedAtMs, report };
    return report;
  }

  private async runProbe(probe: DependencyProbe): Promise<DependencyCheckResult> {
    const startedAt = performance.now();
    try {
      await withTimeout(
        Promise.resolve().then(() => probe.check()),
        this.timeoutMs,
      );
      return {
        name: probe.name,
        status: 'ok',
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    } catch (error) {
      return {
        name: probe.name,
        status: 'down',
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        error: sanitizeDependencyError(error),
      };
    }
  }
}
