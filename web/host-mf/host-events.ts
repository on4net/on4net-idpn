import type { IdpnEvent } from '@idpn/mfe-sdk';

/**
 * Host-side event logging (docs/micro-frontend.md 6).
 *
 * The contract says an event never carries a token, but the host is the party that would
 * be blamed if one ever did (a buggy remote, a future contract change, a wrapped event).
 * Every event is therefore scrubbed before it reaches a log sink: token-like keys are
 * dropped and JWT-shaped strings are replaced with `[redacted]`.
 */

const SENSITIVE_KEY =
  /(access.?token|refresh.?token|id.?token|token|secret|password|passwd|credential|authorization|cookie|api.?key)/i;

const JWT_SHAPE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

const MAX_DEPTH = 4;

export type EventLogSink = (message: string, details: Record<string, unknown>) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Returns a structurally copied, token-free view of an event payload. */
export function redactEventDetail(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return JWT_SHAPE.test(value) ? '[redacted]' : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactEventDetail(entry, depth + 1));
  }
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      continue;
    }
    safe[key] = redactEventDetail(entry, depth + 1);
  }
  return safe;
}

/**
 * Builds the `onEvent` handler passed to every remote.
 *
 * Logs the event type plus a redacted payload. The handler never forwards the event to a
 * network call and never stores it, so an accidental token would not leave the page.
 */
export function createHostEventLogger(sink: EventLogSink): (event: IdpnEvent) => void {
  return (event) => {
    const type = isRecord(event) && typeof event.type === 'string' ? event.type : 'unknown';
    const redacted = redactEventDetail(event);
    sink(`[idpn-host] ${type}`, isRecord(redacted) ? redacted : {});
  };
}
