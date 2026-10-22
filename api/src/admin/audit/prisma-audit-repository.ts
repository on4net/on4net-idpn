import { sanitizeAuditMetadata } from '../../audit/sanitize.js';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type {
  AdminAuditEvent,
  AuditEventCursor,
  AuditEventFilter,
  AuditEventPage,
  AuditEventRepository,
} from './audit-types.js';

const AUDIT_EVENT_SELECT = {
  id: true,
  occurredAt: true,
  actorType: true,
  actorId: true,
  action: true,
  targetType: true,
  targetId: true,
  client: { select: { clientId: true } },
  ip: true,
  userAgent: true,
  result: true,
  metadata: true,
} as const;

type AuditEventRow = {
  id: string;
  occurredAt: Date;
  actorType: AdminAuditEvent['actorType'];
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  client: { clientId: string } | null;
  ip: string | null;
  userAgent: string | null;
  result: AdminAuditEvent['result'];
  metadata: Prisma.JsonValue;
};

/**
 * Metadata is sanitized on write, but rows written before that control existed (or by a
 * future caller that bypasses the adapter) must not leak credentials through the reader.
 */
const safeMetadata = (value: Prisma.JsonValue): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? sanitizeAuditMetadata(value as Record<string, unknown>)
    : {};

const toEvent = (row: AuditEventRow): AdminAuditEvent => ({
  id: row.id,
  occurredAt: row.occurredAt.toISOString(),
  actorType: row.actorType,
  actorId: row.actorId,
  action: row.action,
  targetType: row.targetType,
  targetId: row.targetId,
  clientId: row.client?.clientId ?? null,
  ip: row.ip,
  userAgent: row.userAgent,
  result: row.result,
  metadata: safeMetadata(row.metadata),
});

/**
 * Builds the Prisma filter. `filter.clientId` is the public client id, while
 * `audit_events.client_id` stores an internal UUID, so the two are resolved first.
 * Returns `null` for an unknown client, which matches no row.
 */
async function whereFor(
  prisma: PrismaClient,
  filter: AuditEventFilter,
): Promise<Prisma.AuditEventWhereInput | null> {
  let internalClientId: string | undefined;
  if (filter.clientId !== undefined) {
    const client = await prisma.client.findUnique({
      where: { clientId: filter.clientId },
      select: { id: true },
    });
    if (client === null) {
      return null;
    }
    internalClientId = client.id;
  }

  const occurredAt: Prisma.DateTimeFilter = {
    ...(filter.from === undefined ? {} : { gte: filter.from }),
    ...(filter.to === undefined ? {} : { lte: filter.to }),
  };

  return {
    ...(Object.keys(occurredAt).length === 0 ? {} : { occurredAt }),
    ...(filter.action === undefined ? {} : { action: filter.action }),
    ...(filter.actorId === undefined ? {} : { actorId: filter.actorId }),
    ...(internalClientId === undefined ? {} : { clientId: internalClientId }),
    ...(filter.targetType === undefined ? {} : { targetType: filter.targetType }),
    ...(filter.result === undefined ? {} : { result: filter.result }),
  };
}

/**
 * Prisma-backed audit reader (docs/api.md 3.8).
 *
 * Paging is keyset based on `(occurred_at, id)`: an auditor reading a busy log must not skip
 * or repeat rows because new events shifted an offset. The total is counted only for the
 * first page, and exports never count at all - the count was pure overhead there.
 */
export function createPrismaAuditEventRepository(prisma: PrismaClient): AuditEventRepository {
  const cursorWhere = (cursor: AuditEventCursor | undefined): Prisma.AuditEventWhereInput =>
    cursor === undefined
      ? {}
      : {
          OR: [
            { occurredAt: { lt: cursor.occurredAt } },
            { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
          ],
        };

  return {
    async list(filter, page, limit, cursor): Promise<AuditEventPage> {
      const where = await whereFor(prisma, filter);
      if (where === null) {
        return { items: [], page, limit, total: 0, nextCursor: null };
      }
      const rows = await prisma.auditEvent.findMany({
        where: { ...where, ...cursorWhere(cursor) },
        select: AUDIT_EVENT_SELECT,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor === undefined ? { skip: (page - 1) * limit } : {}),
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(toEvent);
      const total = cursor === undefined ? await prisma.auditEvent.count({ where }) : 0;
      const last = items.at(-1);
      return {
        items,
        page,
        limit,
        total,
        nextCursor:
          hasMore && last !== undefined
            ? Buffer.from(`${last.occurredAt}|${last.id}`, 'utf8').toString('base64url')
            : null,
      };
    },
    async listForExport(filter, limit) {
      const where = await whereFor(prisma, filter);
      if (where === null) {
        return [];
      }
      const rows = await prisma.auditEvent.findMany({
        where,
        select: AUDIT_EVENT_SELECT,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });
      return rows.map(toEvent);
    },
  };
}

/** Decodes an opaque `nextCursor`; invalid values are a client error, never a silent reset. */
export function decodeAuditCursor(value: string): AuditEventCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.lastIndexOf('|');
  if (separator <= 0) {
    return null;
  }
  const occurredAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(occurredAt.getTime()) || id === '') {
    return null;
  }
  return { occurredAt, id };
}
