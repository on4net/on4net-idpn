import type { FastifyInstance } from 'fastify';

/**
 * Receiver for Content-Security-Policy violation reports (`report-to csp`, docs/security.md 7).
 *
 * Browsers POST here without credentials, so the endpoint is unauthenticated by design and is
 * therefore hostile input: the body is size-limited, parsed defensively, rate-limited per
 * address, reduced to a handful of whitelisted fields (URLs are cut to origin + path, never the
 * query or fragment, which can carry tokens) and answered with an empty `204`.
 */

const REPORT_TYPES = ['application/csp-report', 'application/reports+json'] as const;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_REPORTS_PER_REQUEST = 10;
const MAX_FIELD_LENGTH = 200;
const MAX_TRACKED_ADDRESSES = 5_000;

export interface CspReportMetrics {
  recordCspReport(directive: string, disposition: string): void;
}

export interface CspReportLogger {
  warn(entry: Record<string, unknown>, message: string): void;
}

export interface CspReportOptions {
  metrics?: CspReportMetrics;
  /** Defaults to the Fastify request logger. */
  logger?: CspReportLogger;
  /** Reports accepted per address and minute (default 30). */
  perMinute?: number;
  now?: () => number;
}

export interface CspViolation {
  directive: string;
  disposition: string;
  blocked: string;
  document: string;
  sample: string;
}

const clip = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : '';

/** Origin + path only; a query string or fragment can hold a token. */
function stripUrl(value: unknown): string {
  const text = clip(value);
  if (text === '' || ['inline', 'eval', 'data', 'blob', 'self'].includes(text)) {
    return text;
  }
  try {
    const url = new URL(text);
    return `${url.origin}${url.pathname}`.slice(0, MAX_FIELD_LENGTH);
  } catch {
    return '';
  }
}

function fromBody(body: Record<string, unknown>): CspViolation | null {
  const directive = clip(
    body['effectiveDirective'] ?? body['effective-directive'] ?? body['violated-directive'],
  );
  if (directive === '') {
    return null;
  }
  return {
    directive,
    disposition: clip(body['disposition']) || 'enforce',
    blocked: stripUrl(body['blockedURL'] ?? body['blocked-uri']),
    document: stripUrl(body['documentURL'] ?? body['document-uri']),
    sample: clip(body['sample'] ?? body['script-sample']).slice(0, 80),
  };
}

/** Normalises both wire formats (legacy `csp-report`, Reporting API list) into violations. */
export function parseCspReports(payload: unknown): CspViolation[] {
  const found: CspViolation[] = [];
  const consider = (candidate: unknown): void => {
    if (typeof candidate !== 'object' || candidate === null) {
      return;
    }
    const record = candidate as Record<string, unknown>;
    const body = record['csp-report'] ?? record['body'];
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const violation = fromBody(body as Record<string, unknown>);
      if (violation !== null) {
        found.push(violation);
      }
    }
  };
  if (Array.isArray(payload)) {
    payload.slice(0, MAX_REPORTS_PER_REQUEST).forEach(consider);
  } else {
    consider(payload);
  }
  return found;
}

export function registerCspReportRoute(app: FastifyInstance, options: CspReportOptions = {}): void {
  const now = options.now ?? Date.now;
  const perMinute = options.perMinute ?? 30;
  const windows = new Map<string, { count: number; resetAt: number }>();

  const allow = (address: string): boolean => {
    const at = now();
    const window = windows.get(address);
    if (window === undefined || window.resetAt <= at) {
      if (windows.size >= MAX_TRACKED_ADDRESSES) {
        for (const [key, value] of windows) {
          if (value.resetAt <= at) {
            windows.delete(key);
          }
        }
        if (windows.size >= MAX_TRACKED_ADDRESSES) {
          return false;
        }
      }
      windows.set(address, { count: 1, resetAt: at + 60_000 });
      return true;
    }
    window.count += 1;
    return window.count <= perMinute;
  };

  // Encapsulated so the extra content types never leak to the rest of the API.
  void app.register((scope, _opts, done) => {
    for (const type of REPORT_TYPES) {
      scope.addContentTypeParser(
        type,
        { parseAs: 'string', bodyLimit: MAX_BODY_BYTES },
        (_request, body, next) => {
          try {
            next(null, JSON.parse(String(body)) as unknown);
          } catch {
            next(null, null);
          }
        },
      );
    }
    scope.post('/csp-report', { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
      if (allow(request.ip)) {
        const violations = parseCspReports(request.body);
        for (const violation of violations) {
          options.metrics?.recordCspReport(violation.directive, violation.disposition);
          (options.logger ?? request.log).warn({ csp: violation }, 'csp violation reported');
        }
      }
      return reply.code(204).header('Cache-Control', 'no-store').send();
    });
    done();
  });
}
