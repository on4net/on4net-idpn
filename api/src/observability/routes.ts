import { timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { DependencyMonitor } from './health.js';
import type { ApiMetrics } from './metrics.js';

/** Health and scrape endpoints are excluded from the SLO metrics they would otherwise skew. */
const EXCLUDED_ROUTES = new Set(['/healthz', '/readyz', '/metrics']);

export interface HttpMetricsOptions {
  metrics: ApiMetrics;
}

/**
 * Counts every routed request by method, matched route and status, plus the domain-specific
 * outcomes the alerts need. Raw URLs are never used as labels, so ids, emails or query
 * values cannot create cardinality or leak into `/metrics`.
 */
export function registerHttpMetrics(app: FastifyInstance, options: HttpMetricsOptions): void {
  const startedAt = new WeakMap<FastifyRequest, number>();
  const { metrics } = options;

  app.addHook('onRequest', async (request) => {
    startedAt.set(request, performance.now());
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const status = reply.statusCode;

    if (!EXCLUDED_ROUTES.has(route)) {
      const started = startedAt.get(request);
      const durationSeconds =
        started === undefined ? 0 : Math.max(0, (performance.now() - started) / 1000);
      metrics.recordHttpRequest({
        method: request.method,
        route,
        status,
        durationSeconds,
      });
      if (status === 401 || status === 403) {
        metrics.recordAuthFailure(route, authFailureReason(route, status));
      }
    }

    if (route === '/oauth2/token') {
      const body = request.body as { grant_type?: unknown } | undefined;
      const grantType = typeof body?.grant_type === 'string' ? body.grant_type : 'unknown';
      const success = status >= 200 && status < 300;
      metrics.recordTokenRequest({ grantType, success });
    }

    if (route === '/oauth2/revoke' && status === 200) {
      metrics.recordTokenRevocation();
    }
  });
}

function authFailureReason(route: string, status: number): string {
  if (status === 403) {
    return 'forbidden';
  }
  if (route === '/oauth2/token' || route === '/oauth2/revoke' || route === '/oauth2/introspect') {
    return 'invalid_client';
  }
  if (route === '/api/v1/login' || route.startsWith('/api/v1/login/')) {
    return 'login_failed';
  }
  return 'unauthenticated';
}

export interface MetricsRouteOptions {
  metrics: ApiMetrics;
  /** Optional async gauge collector; failures are counted and never fail the scrape. */
  collect?: () => Promise<void>;
  /** When set, `/metrics` requires `Authorization: Bearer <token>`. */
  token?: string;
}

function hasValidBearerToken(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string') {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) {
    return false;
  }
  const provided = Buffer.from(match[1] ?? '', 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

/**
 * `GET /metrics` in the Prometheus text format (docs/monitoring.md). It is opt-in
 * (`METRICS_ENABLED=true`) and should only be reachable from the internal network; the
 * optional bearer token protects it when the proxy cannot enforce that.
 */
export function registerMetricsRoute(app: FastifyInstance, options: MetricsRouteOptions): void {
  app.get('/metrics', async (request, reply) => {
    if (
      options.token !== undefined &&
      !hasValidBearerToken(request.headers.authorization, options.token)
    ) {
      options.metrics.recordAuthFailure('/metrics', 'invalid_token');
      return reply
        .header('WWW-Authenticate', 'Bearer realm="metrics"')
        .header('Cache-Control', 'no-store')
        .code(401)
        .send({ error: 'unauthorized' });
    }

    if (options.collect !== undefined) {
      try {
        await options.collect();
      } catch (error) {
        request.log.warn({ err: error }, 'metrics gauge collection failed');
      }
    }

    return reply
      .header('Cache-Control', 'no-store')
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(options.metrics.render());
  });
}

/**
 * `GET /readyz` runs every dependency probe with a timeout and returns `503` when one is
 * down (docs/monitoring.md). `/healthz` remains a process-liveness probe.
 */
export function registerReadinessRoute(app: FastifyInstance, monitor: DependencyMonitor): void {
  app.get('/readyz', async (_request, reply) => {
    const report = await monitor.check({ fresh: true });
    return reply
      .header('Cache-Control', 'no-store')
      .code(report.status === 'ok' ? 200 : 503)
      .send(report);
  });
}
