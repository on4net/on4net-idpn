export type AuditActorType = 'user' | 'admin' | 'service' | 'system' | 'anonymous';
export type AuditResult = 'success' | 'failure';

export interface AuditEventInput {
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  clientId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  result: AuditResult;
  metadata?: Record<string, unknown>;
}

/** Keys that must never reach the audit log (docs/security.md 7). */
const SENSITIVE_METADATA_KEY = /(password|secret|token|credential|hash|pepper)/i;

/**
 * Removes credentials from audit metadata. Nested objects are scrubbed too, so a caller
 * cannot leak a password by wrapping it in `{ user: { password } }`.
 */
export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (metadata === undefined) {
    return {};
  }
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_METADATA_KEY.test(key)) {
      continue;
    }
    if (value !== null && typeof value === 'object') {
      if (Array.isArray(value)) {
        safe[key] = value.map((entry) =>
          entry !== null && typeof entry === 'object'
            ? sanitizeAuditMetadata(entry as Record<string, unknown>)
            : entry,
        );
      } else {
        safe[key] = sanitizeAuditMetadata(value as Record<string, unknown>);
      }
      continue;
    }
    safe[key] = value;
  }
  return safe;
}
