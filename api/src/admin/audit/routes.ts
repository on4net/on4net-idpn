import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AdminAudit } from '../admin-types.js';
import {
  authorizeAdminRequest,
  type AdminAuthorization,
  type PermissionReader,
  type TokenVerifier,
} from '../authorize.js';
import { sendProblem } from '../routes.js';
import { exportAuditEventsQuerySchema, listAuditEventsQuerySchema } from './audit-schemas.js';
import type {
  AdminAuditEvent,
  AuditEventFilter,
  AuditEventRepository,
  AuditExportFormat,
} from './audit-types.js';

/** Hard upper bound for one export; keeps a single request from exhausting the API. */
export const MAX_AUDIT_EXPORT_ROWS = 10_000;

const READ_PERMISSION = 'idp:audit:read';
const EXPORT_PERMISSION = 'idp:audit:export';

export interface AuditRoutesOptions {
  issuer: string;
  adminClientId: string;
  verifier: TokenVerifier;
  permissions: PermissionReader;
  events: AuditEventRepository;
  audit: AdminAudit;
  /** Row cap for exports; defaults to `MAX_AUDIT_EXPORT_ROWS`, injectable for tests. */
  maxExportRows?: number;
}

const CSV_HEADER = [
  'id',
  'occurredAt',
  'actorType',
  'actorId',
  'action',
  'targetType',
  'targetId',
  'clientId',
  'ip',
  'userAgent',
  'result',
  'metadata',
].join(',');

/** A leading `=`, `+`, `-`, `@`, tab or CR makes spreadsheet software evaluate a cell. */
const CSV_INJECTION = /^[=+\-@\t\r]/;

export function csvCell(value: string | null): string {
  const raw = value ?? '';
  const guarded = CSV_INJECTION.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function formatAuditEventsCsv(events: readonly AdminAuditEvent[]): string {
  const lines = events.map((event) =>
    [
      event.id,
      event.occurredAt,
      event.actorType,
      event.actorId,
      event.action,
      event.targetType,
      event.targetId,
      event.clientId,
      event.ip,
      event.userAgent,
      event.result,
      JSON.stringify(event.metadata),
    ]
      .map((value) => csvCell(value))
      .join(','),
  );
  return [CSV_HEADER, ...lines].join('\n');
}

export function formatAuditEventsNdjson(events: readonly AdminAuditEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

const validationDetail = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

const filterOf = (query: {
  from?: Date;
  to?: Date;
  action?: string;
  actorId?: string;
  clientId?: string;
  targetType?: string;
  result?: 'success' | 'failure';
}): AuditEventFilter => ({
  ...(query.from === undefined ? {} : { from: query.from }),
  ...(query.to === undefined ? {} : { to: query.to }),
  ...(query.action === undefined ? {} : { action: query.action }),
  ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
  ...(query.clientId === undefined ? {} : { clientId: query.clientId }),
  ...(query.targetType === undefined ? {} : { targetType: query.targetType }),
  ...(query.result === undefined ? {} : { result: query.result }),
});

/** Registers the audit read and export endpoints (docs/api.md 3.8). */
export function registerAuditAdminRoutes(app: FastifyInstance, options: AuditRoutesOptions): void {
  const maxExportRows = Math.max(1, options.maxExportRows ?? MAX_AUDIT_EXPORT_ROWS);

  const guard = async (
    request: FastifyRequest,
    reply: FastifyReply,
    permission: string,
  ): Promise<{ userId: string; clientId: string } | null> => {
    const auth: AdminAuthorization = await authorizeAdminRequest(
      request,
      {
        issuer: options.issuer,
        adminClientId: options.adminClientId,
        verifier: options.verifier,
        permissions: options.permissions,
      },
      permission,
    );
    if (!auth.ok) {
      if (auth.status === 401) {
        reply.header('WWW-Authenticate', 'Bearer "invalid_token"');
      }
      void sendProblem(
        reply,
        auth.status,
        auth.status === 401 ? 'unauthorized' : 'forbidden',
        auth.status === 401 ? 'Unauthorized' : 'Forbidden',
        auth.message,
      );
      return null;
    }
    return { userId: auth.principal.userId, clientId: auth.principal.clientId };
  };

  app.get('/api/v1/audit-events', async (request, reply) => {
    const principal = await guard(request, reply, READ_PERMISSION);
    if (principal === null) {
      return reply;
    }
    const parsed = listAuditEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        validationDetail(parsed.error),
        '/api/v1/audit-events',
      );
    }
    const { page, limit } = parsed.data;
    const result = await options.events.list(filterOf(parsed.data), page, limit);
    return reply.header('Cache-Control', 'no-store').send(result);
  });

  app.get('/api/v1/audit-events/export', async (request, reply) => {
    const principal = await guard(request, reply, EXPORT_PERMISSION);
    if (principal === null) {
      return reply;
    }
    const parsed = exportAuditEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(
        reply,
        422,
        'validation-error',
        'Validation failed',
        validationDetail(parsed.error),
        '/api/v1/audit-events/export',
      );
    }
    const query = parsed.data;
    const filter = filterOf(query);
    const events = await options.events.listForExport(filter, maxExportRows);

    // Export is a sensitive read and must itself leave a trace (docs/security.md 10).
    await options.audit.record({
      actorType: 'admin',
      actorId: principal.userId,
      action: 'audit.export',
      targetType: 'audit',
      clientId: principal.clientId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      result: 'success',
      metadata: {
        format: query.format,
        rows: events.length,
        ...(query.from === undefined ? {} : { from: query.from.toISOString() }),
        ...(query.to === undefined ? {} : { to: query.to.toISOString() }),
        ...(query.action === undefined ? {} : { action: query.action }),
        ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
        ...(query.clientId === undefined ? {} : { clientId: query.clientId }),
        ...(query.targetType === undefined ? {} : { targetType: query.targetType }),
        ...(query.result === undefined ? {} : { result: query.result }),
      },
    });

    const body = formatBody(events, query.format);
    const filename = `audit-events-${new Date().toISOString().replace(/[:.]/g, '-')}.${query.format}`;
    return reply
      .header('Content-Type', contentType(query.format))
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Cache-Control', 'no-store')
      .send(body);
  });
}

const formatBody = (events: readonly AdminAuditEvent[], format: AuditExportFormat): string =>
  format === 'ndjson' ? formatAuditEventsNdjson(events) : formatAuditEventsCsv(events);

const contentType = (format: AuditExportFormat): string =>
  format === 'ndjson' ? 'application/x-ndjson; charset=utf-8' : 'text/csv; charset=utf-8';
