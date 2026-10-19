import { sanitizeAuditMetadata } from '../../audit/sanitize.js';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type {
  AdminAuditEvent,
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

/** Prisma-backed audit reader (docs/api.md 3.8). */
export function createPrismaAuditEventRepository(prisma: PrismaClient): AuditEventRepository {
  const find = async (
    filter: AuditEventFilter,
    take: number,
    skip: number,
  ): Promise<{ items: AdminAuditEvent[]; total: number }> => {
    const where = await whereFor(prisma, filter);
    if (where === null) {
      return { items: [], total: 0 };
    }
    const [rows, total] = await Promise.all([
      prisma.auditEvent.findMany({
        where,
        select: AUDIT_EVENT_SELECT,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take,
        skip,
      }),
      prisma.auditEvent.count({ where }),
    ]);
    return { items: rows.map(toEvent), total };
  };

  return {
    async list(filter, page, limit): Promise<AuditEventPage> {
      const { items, total } = await find(filter, limit, (page - 1) * limit);
      return { items, page, limit, total };
    },
    async listForExport(filter, limit) {
      return (await find(filter, limit, 0)).items;
    },
  };
}
