import { hostname } from 'node:os';

/**
 * Structured request logging (docs/monitoring.md).
 *
 * Every request gets an `X-Request-Id` that is either the caller's well-formed value or a
 * generated UUID, and is logged as `request_id`. The serializers log only the method,
 * redacted URL, matched route and remote address: headers and bodies (which carry bearer
 * tokens, cookies and OAuth parameters) never reach the log stream. The `redact` list is a
 * second layer for any future log call that passes such an object explicitly.
 */
export const LOG_SERVICE_NAME = 'on4net-idpn-api';
export const REDACTED = '[redacted]';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'assertion',
  'client_secret',
  'code',
  'id_token',
  'id_token_hint',
  'otp',
  'password',
  'refresh_token',
  'token',
  'totp',
]);

export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-metrics-token"]',
  'res.headers["set-cookie"]',
  'password',
  'secret',
  'client_secret',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'code_verifier',
  'token',
  'assertion',
  'otp',
  'totp',
  '*.password',
  '*.secret',
  '*.client_secret',
  '*.access_token',
  '*.refresh_token',
  '*.id_token',
  '*.token',
];

/** Accepts only a bounded, token-safe request id so a header cannot inject log lines. */
export function sanitizeRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** Replaces sensitive query parameter values; the path and other parameters stay readable. */
export function redactUrl(rawUrl: string): string {
  const queryStart = rawUrl.indexOf('?');
  if (queryStart === -1) {
    return rawUrl;
  }
  const path = rawUrl.slice(0, queryStart);
  const query = rawUrl.slice(queryStart + 1);
  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      params.set(key, 'redacted');
    }
  }
  const rendered = params.toString();
  return rendered === '' ? path : `${path}?${rendered}`;
}

/**
 * One bounded line without URL credentials or `key=value` secrets. Use this whenever an
 * exception message is logged in a free-form field (client errors may embed a URL).
 */
export function sanitizeLogMessage(error: unknown, maxLength = 300): string {
  const raw = error instanceof Error ? error.message : String(error);
  const singleLine = raw.replace(/[\r\n\t]+/g, ' ').trim();
  const withoutUserInfo = singleLine.replace(/\/\/[^/@\s]+@/g, '//***@');
  const withoutPairs = withoutUserInfo.replace(
    /\b(password|passwd|secret|token|pwd)\s*=\s*[^\s&;]+/gi,
    '$1=***',
  );
  return withoutPairs.slice(0, maxLength) || 'unknown error';
}

interface RequestLike {
  id?: unknown;
  method?: unknown;
  url?: unknown;
  ip?: unknown;
  routeOptions?: { url?: unknown };
}

/** Pino serializer: allowlist of request fields, no headers, no body, no raw query secrets. */
export function requestLogSerializer(request: unknown): Record<string, unknown> {
  const value = (request ?? {}) as RequestLike;
  const route = typeof value.routeOptions?.url === 'string' ? value.routeOptions.url : 'unmatched';
  return {
    request_id: typeof value.id === 'string' ? value.id : undefined,
    method: typeof value.method === 'string' ? value.method : undefined,
    url: typeof value.url === 'string' ? redactUrl(value.url) : undefined,
    route,
    remote_address: typeof value.ip === 'string' ? value.ip : undefined,
  };
}

/** Pino serializer: status only; response headers never reach the log stream. */
export function responseLogSerializer(reply: unknown): Record<string, unknown> {
  const value = (reply ?? {}) as { statusCode?: unknown };
  return {
    statusCode: typeof value.statusCode === 'number' ? value.statusCode : undefined,
  };
}

/** Pino serializer: sanitized message and a bounded stack (no URL credentials/secrets). */
export function errorLogSerializer(error: unknown): {
  [key: string]: unknown;
  type: string;
  message: string;
  stack: string;
} {
  const value = (error ?? {}) as { type?: unknown; stack?: unknown };
  const stack =
    typeof value.stack === 'string' ? redactSecretsInText(value.stack).slice(0, 4000) : '';
  return {
    type: typeof value.type === 'string' ? value.type : 'Error',
    message: sanitizeLogMessage(error, 500),
    stack,
  };
}

function redactSecretsInText(text: string): string {
  return text
    .replace(/\/\/[^/@\s]+@/g, '//***@')
    .replace(/\b(password|passwd|secret|token|pwd)\s*=\s*[^\s&;]+/gi, '$1=***');
}

/** Fastify/Pino logger options; JSON on stdout, one line per event. */
export function buildLoggerOptions(level: string): {
  level: string;
  base: Record<string, unknown>;
  timestamp: () => string;
  formatters: { level: (label: string) => { level: string } };
  redact: { paths: string[]; censor: string };
  serializers: {
    req: typeof requestLogSerializer;
    res: typeof responseLogSerializer;
    err: typeof errorLogSerializer;
  };
} {
  return {
    level,
    base: { service: LOG_SERVICE_NAME, pid: process.pid, hostname: hostname() },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    serializers: {
      req: requestLogSerializer,
      res: responseLogSerializer,
      err: errorLogSerializer,
    },
  };
}
