/**
 * Security alerts (`docs/security.md` 9.2).
 *
 * An audit event answers "what happened" for compliance; an alert asks an operator to look
 * now. The two channels are separate on purpose: the audit writer is append-only and must not
 * grow a paging dependency, while alerting must never be able to fail an authentication
 * response. The sink is injected so a deployment can log, bump a metric and forward to its
 * pager without the auth routes knowing about that infrastructure.
 */

export type SecurityAlertType =
  | 'mfa.lockout'
  | 'mfa.challenge_exhausted'
  | 'token.refresh_reuse';

export type SecurityAlertSeverity = 'critical' | 'high' | 'medium';

export interface SecurityAlert {
  type: SecurityAlertType;
  severity: SecurityAlertSeverity;
  userId?: string | null;
  clientId?: string | null;
  ip?: string | null;
  detail?: Record<string, string | number | boolean | null>;
}

export interface SecurityAlertSink {
  raise(alert: SecurityAlert): void;
}

export interface SecurityAlertDelivery {
  log(alert: SecurityAlert): void;
  /** Optional metric/forwarder; a failure here must not suppress the log line. */
  metric?: (alert: SecurityAlert) => void;
}

export function createSecurityAlertSink(delivery: SecurityAlertDelivery): SecurityAlertSink {
  return {
    raise(alert) {
      try {
        delivery.metric?.(alert);
      } catch {
        // A metrics hiccup must never hide the alert.
      }
      try {
        delivery.log(alert);
      } catch {
        // Alerting is best effort; it must never change an auth response.
      }
    },
  };
}
