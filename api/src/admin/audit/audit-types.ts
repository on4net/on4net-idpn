import type { AuditActorType, AuditResult } from '../../audit/sanitize.js';

/** Audit event as exposed by the Admin API; `clientId` is the public client id. */
export interface AdminAuditEvent {
  id: string;
  occurredAt: string;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  clientId: string | null;
  ip: string | null;
  userAgent: string | null;
  result: AuditResult;
  metadata: Record<string, unknown>;
}

export interface AuditEventFilter {
  from?: Date;
  to?: Date;
  action?: string;
  actorId?: string;
  /** Public client id; resolved to the internal UUID by the repository. */
  clientId?: string;
  targetType?: string;
  result?: AuditResult;
}

export interface AuditEventPage {
  items: AdminAuditEvent[];
  page: number;
  limit: number;
  total: number;
}

export type AuditExportFormat = 'csv' | 'ndjson';

/** Persistence port for the audit endpoints (docs/api.md 3.8). */
export interface AuditEventRepository {
  list(filter: AuditEventFilter, page: number, limit: number): Promise<AuditEventPage>;
  /** Most recent `limit` events matching the filter, ordered newest first. */
  listForExport(filter: AuditEventFilter, limit: number): Promise<AdminAuditEvent[]>;
}
