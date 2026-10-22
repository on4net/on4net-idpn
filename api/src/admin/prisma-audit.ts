import { recordAuditEvent } from '../audit/prisma-audit.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { AdminAudit } from './admin-types.js';

/**
 * Audit adapter for the Admin API.
 *
 * `audit_events.client_id` is a foreign key, so the public client id carried by the access
 * token is translated to the internal UUID first; an unknown client is recorded as null
 * instead of dropping the event.
 */
/** Bounded so an attacker-supplied `clientId` cannot grow the map without limit. */
const MAX_CACHED_CLIENTS = 500;

export function createPrismaAdminAudit(prisma: PrismaClient): AdminAudit {
  const cache = new Map<string, string | null>();

  const resolveClient = async (clientId: string | null | undefined): Promise<string | null> => {
    if (clientId === null || clientId === undefined) {
      return null;
    }
    if (cache.has(clientId)) {
      return cache.get(clientId) ?? null;
    }
    const row = await prisma.client.findUnique({
      where: { clientId },
      select: { id: true },
    });
    cache.set(clientId, row?.id ?? null);
    if (cache.size > MAX_CACHED_CLIENTS) {
      // Insertion order = age; drop the oldest entry (card #72 finding 1).
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    return row?.id ?? null;
  };

  return {
    async record(event) {
      await recordAuditEvent(prisma, {
        ...event,
        clientId: await resolveClient(event.clientId),
      });
    },
  };
}
