import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * User consent for third-party clients (card #81, docs/auth-flows.md, docs/security.md T19/T20).
 *
 * A client the tenant marked first-party (`Client.firstParty`, the default) never prompts. Any
 * other client needs a recorded approval that covers every scope it asks for; the approval lives
 * in the `consents` table, one row per (user, client). Approving again with more scopes widens
 * the row, revoking it makes the next `/oauth2/authorize` prompt again.
 */

export interface ConsentGrant {
  clientId: string;
  clientName: string;
  scopes: string[];
  grantedAt: string;
}

export interface ConsentRepository {
  /** True when an active approval covers every requested scope (a superset is fine). */
  isGranted(userId: string, clientId: string, scopes: readonly string[]): Promise<boolean>;
  /** Records or widens the approval; scopes approved earlier stay approved. */
  grant(userId: string, clientId: string, scopes: readonly string[], at: Date): Promise<void>;
  /** Revokes the approval; `false` when there was none. */
  revoke(userId: string, clientId: string, at: Date): Promise<boolean>;
  listForUser(userId: string): Promise<ConsentGrant[]>;
}

export function createPrismaConsentRepository(prisma: PrismaClient): ConsentRepository {
  const internalClient = async (clientId: string): Promise<string | null> =>
    (await prisma.client.findUnique({ where: { clientId }, select: { id: true } }))?.id ?? null;

  return {
    async isGranted(userId, clientId, scopes) {
      const row = await prisma.consent.findFirst({
        where: { userId, client: { clientId }, revokedAt: null },
        select: { scopes: true },
      });
      if (row === null) {
        return false;
      }
      const granted = new Set(row.scopes);
      return scopes.every((scope) => granted.has(scope));
    },

    async grant(userId, clientId, scopes, at) {
      const client = await internalClient(clientId);
      if (client === null) {
        throw new Error('consent for an unknown client');
      }
      const existing = await prisma.consent.findUnique({
        where: { userId_clientId: { userId, clientId: client } },
        select: { scopes: true, revokedAt: true },
      });
      const kept = existing === null || existing.revokedAt !== null ? [] : existing.scopes;
      const merged = [...new Set([...kept, ...scopes])].sort();
      await prisma.consent.upsert({
        where: { userId_clientId: { userId, clientId: client } },
        create: { userId, clientId: client, scopes: merged, grantedAt: at },
        update: { scopes: merged, grantedAt: at, revokedAt: null },
      });
    },

    async revoke(userId, clientId, at) {
      const result = await prisma.consent.updateMany({
        where: { userId, client: { clientId }, revokedAt: null },
        data: { revokedAt: at },
      });
      return result.count > 0;
    },

    async listForUser(userId) {
      const rows = await prisma.consent.findMany({
        where: { userId, revokedAt: null },
        select: {
          scopes: true,
          grantedAt: true,
          client: { select: { clientId: true, name: true } },
        },
        orderBy: { grantedAt: 'desc' },
      });
      return rows.map((row) => ({
        clientId: row.client.clientId,
        clientName: row.client.name,
        scopes: row.scopes,
        grantedAt: row.grantedAt.toISOString(),
      }));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pending consent requests: the browser only ever carries an opaque handle.
// ---------------------------------------------------------------------------------------------

export const CONSENT_REQUEST_TTL_SECONDS = 10 * 60;

export interface ConsentRequest {
  userId: string;
  clientId: string;
  scopes: string[];
  /** Absolute `/oauth2/authorize` URL to resume after approval (validated by `/authorize`). */
  authorizeUrl: string;
  createdAt: string;
}

export interface ConsentRequestStore {
  create(input: Omit<ConsentRequest, 'createdAt'> & { now?: Date }): Promise<string>;
  /** Reads without consuming, so the screen can render it. */
  peek(id: string): Promise<ConsentRequest | null>;
  /** Single use: the decision consumes the request. */
  take(id: string): Promise<ConsentRequest | null>;
}

const requestSchema = z.object({
  userId: z.string().min(1),
  clientId: z.string().min(1).max(64),
  scopes: z.array(z.string().min(1).max(100)).max(50),
  authorizeUrl: z.string().url(),
  createdAt: z.string(),
});

const KEY = 'idpn:consent:request:';

/** The part of ioredis this store needs, declared structurally. */
export interface ConsentRequestRedis {
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

const parse = (raw: string | null): ConsentRequest | null => {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = requestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** A well-formed handle is 43 URL-safe characters; anything else never reaches Redis. */
const HANDLE = /^[A-Za-z0-9_-]{43}$/;

export class RedisConsentRequestStore implements ConsentRequestStore {
  constructor(private readonly redis: ConsentRequestRedis) {}

  async create(input: Omit<ConsentRequest, 'createdAt'> & { now?: Date }): Promise<string> {
    const id = randomBytes(32).toString('base64url');
    const record: ConsentRequest = {
      userId: input.userId,
      clientId: input.clientId,
      scopes: input.scopes,
      authorizeUrl: input.authorizeUrl,
      createdAt: (input.now ?? new Date()).toISOString(),
    };
    await this.redis.set(`${KEY}${id}`, JSON.stringify(record), 'EX', CONSENT_REQUEST_TTL_SECONDS);
    return id;
  }

  async peek(id: string): Promise<ConsentRequest | null> {
    return HANDLE.test(id) ? parse(await this.redis.get(`${KEY}${id}`)) : null;
  }

  async take(id: string): Promise<ConsentRequest | null> {
    return HANDLE.test(id) ? parse(await this.redis.getdel(`${KEY}${id}`)) : null;
  }
}

export class MemoryConsentRequestStore implements ConsentRequestStore {
  private readonly entries = new Map<string, { record: ConsentRequest; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async create(input: Omit<ConsentRequest, 'createdAt'> & { now?: Date }): Promise<string> {
    const id = randomBytes(32).toString('base64url');
    this.entries.set(id, {
      record: {
        userId: input.userId,
        clientId: input.clientId,
        scopes: input.scopes,
        authorizeUrl: input.authorizeUrl,
        createdAt: (input.now ?? new Date()).toISOString(),
      },
      expiresAt: this.now() + CONSENT_REQUEST_TTL_SECONDS * 1000,
    });
    return id;
  }

  async peek(id: string): Promise<ConsentRequest | null> {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.expiresAt <= this.now()) {
      this.entries.delete(id);
      return null;
    }
    return entry.record;
  }

  async take(id: string): Promise<ConsentRequest | null> {
    const record = await this.peek(id);
    this.entries.delete(id);
    return record;
  }
}
